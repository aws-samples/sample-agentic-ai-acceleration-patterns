// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeleteParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { classify, EXPECT, meets, type RequestKind } from './classify';
import { forgeToken, IdentityClient, newUlid, payloadOf, Registrar, registrarCause, retrying, unsignedToken } from './clients';
import { loadEdgeRows } from './collect';
import { sweep } from './driver';
import * as http from './http';
import { compareCell, expectedAtCell, joinEdge, type EdgeRow } from './join';
import { paced, pool, Rate } from './load';
import { drawsOf, parseTier, planOf, tenantsToSeed } from './plan';
import { percentiles, Recorder } from './recorder';
import { type Watch, watchRoute, writeAnswer } from './scenarios';
import { assumedCredentials, regionOf, signedCaller } from './sigv4';
import { Sink, answerOf } from './sink';
import type { Env, RequestLine } from './state';
import { parseDraws } from '../../../../stress/src/budget';
import { recordProblems } from '../../../../stress/src/result';

const SMALL = JSON.stringify({ name: 'small', tenantsSeeded: 20, tenantsActive: 20, onboarding: 'every-run', churnPerRun: 5, steadyRps: 10, peakRps: 40, scenarioSeconds: 60 });
const LARGE = JSON.stringify({ name: 'large', tenantsSeeded: 4000, tenantsActive: 1000, onboarding: 'fixture', churnPerRun: 100, steadyRps: 500, peakRps: 1000, scenarioSeconds: 600 });

const router = (status: number, headers: Record<string, string> = {}) => ({ status, headers, body: `{"status":${status}}` });
const cell = (status: number, message: string) => ({ status, headers: {}, body: `{"message":"${message}"}` });

describe('plan', () => {
  it('reads the tier and refuses a bad one', () => {
    expect(parseTier(SMALL).steadyRps).toBe(10);
    expect(() => parseTier(undefined)).toThrow('STRESS_TIER_JSON is not set');
    expect(() => parseTier('{"name":"huge"}')).toThrow('name must be');
    expect(() => parseTier(SMALL.replace('"steadyRps":10', '"steadyRps":0'))).toThrow('steadyRps');
  });

  it('sizes the small tier from the spec', () => {
    const p = planOf(parseTier(SMALL));
    expect(p).toMatchObject({ activeTenants: 20, writeBurst: 20, sustainedWrites: 30, routeWatchSeconds: 90, steadySeconds: 40, peakSeconds: 20 });
    expect(tenantsToSeed(p)).toBe(20 + 20 + 30 + 1);
  });

  it('caps the seeded tenants and the burst at the large tier', () => {
    const p = planOf(parseTier(LARGE));
    expect(p.activeTenants).toBe(100);
    expect(p.writeBurst).toBe(100);
    expect(p.sustainedWriteSeconds).toBe(60);
  });

  it('draws on Lambda concurrency in the platform account only', () => {
    expect(drawsOf(parseTier(SMALL))).toEqual([{ account: 'platform', quota: 'lambda-concurrency', amount: 30 }]);
  });
});

describe('classify', () => {
  it('names the router, cell and CloudFront refusals', () => {
    expect(classify('no-token', router(401))).toMatchObject({ reason: 'edge-no-token', known: true });
    expect(classify('bad-token', router(401))).toMatchObject({ reason: 'edge-undecodable-token' });
    expect(classify('tenants-list', router(401))).toMatchObject({ reason: 'edge-tenants-list' });
    expect(classify('unrouted', router(403))).toMatchObject({ reason: 'edge-no-route' });
    expect(classify('cross-site', router(403))).toMatchObject({ reason: 'edge-cross-site' });
    expect(classify('suspended', router(503, { 'retry-after': '300' }))).toMatchObject({ reason: 'edge-suspended' });
    expect(classify('whoami', router(503))).toMatchObject({ reason: 'edge-no-cell' });
    expect(classify('agents-closed', router(404))).toMatchObject({ reason: 'edge-agents-closed' });
    expect(classify('forged-payload', cell(403, 'forbidden'))).toMatchObject({ reason: 'cell-forbidden' });
    expect(classify('whoami', cell(429, 'too many requests'))).toMatchObject({ reason: 'cell-rate-limited' });
    expect(classify('token-too-long', { status: 494, headers: {}, body: '' })).toMatchObject({ reason: 'cloudfront-header-too-large' });
    expect(classify('direct-origin', { status: 403, headers: {}, body: '{"Message":"Forbidden"}' })).toMatchObject({ reason: 'origin-iam-denied' });
    expect(classify('whoami', { status: 200, headers: {}, body: '{}' })).toEqual({ served: true, known: true });
  });

  it('leaves an answer no hop owns unknown', () => {
    expect(classify('whoami', { status: 502, headers: {}, body: '<html>' }).known).toBe(false);
    expect(classify('whoami', { status: 0, headers: {}, body: '' }).known).toBe(false);
    expect(classify('whoami', { status: 403, headers: {}, body: '{"status":404}' }).known).toBe(false);
    expect(classify('whoami', cell(403, 'surprise')).known).toBe(false);
  });

  it('knows what each kind may get back', () => {
    const kinds = Object.keys(EXPECT) as RequestKind[];
    expect(kinds).toHaveLength(15);
    expect(meets('forged-payload', { served: true, known: true })).toBe(false);
    expect(meets('forged-payload', { served: false, reason: 'cell-forbidden', known: true })).toBe(true);
    expect(meets('whoami', { served: false, reason: 'edge-no-route', known: true })).toBe(false);
    expect(meets('route-watch', { served: false, reason: 'edge-no-route', known: true })).toBe(true);
    expect(meets('client-route-header', { served: true, known: true })).toBe(true);
  });
});

describe('recorder and sink', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
    expect(percentiles(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  it('counts a mismatch when a probe that must be refused is served, and an assertion when it is refused', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    const ok = { status: 403, headers: { 'x-amz-cf-id': 'abc' }, body: '{"message":"forbidden"}', ttfb: 0.1, total: 0.2 };
    sink.take({ kind: 'forged-payload', tenant: 'T1', edgeTenant: 't1' }, ok);
    sink.take({ kind: 'forged-payload', tenant: 'T1', edgeTenant: 't1' }, { ...ok, status: 200, body: '{"tenantId":"T2","routeHint":"t2"}' });
    sink.flush();
    expect(rec.counts).toMatchObject({ assertions: 2, mismatches: 1, unattributed: 0 });
    expect(rec.failures.join()).toContain('forged-payload: answered 200');
    expect(sink.lines.map((l) => l.id)).toEqual(['abc', 'abc']);
  });

  it('checks the tenant a served answer names and the route hint', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    const r = (tenantId: string, routeHint: string) => ({ status: 200, headers: {}, body: JSON.stringify({ tenantId, routeHint, cellId: 'c' }), ttfb: 0, total: 0.1 });
    sink.take({ kind: 'whoami', tenant: 'T1', expect: 'T1' }, r('T1', 't1'));
    sink.take({ kind: 'whoami', tenant: 'T1', expect: 'T1' }, r('T2', 't2'));
    sink.take({ kind: 'whoami', tenant: 'T1', expect: 'T1' }, r('T1', 't2'));
    expect(rec.counts).toMatchObject({ assertions: 3, mismatches: 2 });
    expect(answerOf('not json')).toEqual({});
  });

  it('attributes a refusal to a tenant and a reason, and counts an unknown answer as unattributed', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    sink.take({ kind: 'no-token', tenant: '-', edgeTenant: '-' }, { status: 401, headers: {}, body: '{"status":401}', ttfb: 0, total: 0.05 });
    sink.take({ kind: 'whoami', tenant: 'T1', expect: 'T1' }, { status: 502, headers: {}, body: '<html>', ttfb: 0, total: 0.05 });
    const record = rec.build({ runId: 'r', tier: 'small', mode: 'slice', commit: 'abcdef0' }, 'edge-refusals');
    expect(record.requests).toEqual({ '401:edge-no-token': 1, '502': 1 });
    expect(record.refusals).toEqual({ byTenantReason: [{ tenant: '-', reason: 'edge-no-token', count: 1 }], unattributed: 1 });
    expect(record.slice).toBe('tenant-front-door');
    expect(record.latency.client.p50).toBeGreaterThan(0);
  });
});

describe('join', () => {
  const line = (id: string, over: Partial<RequestLine> = {}): RequestLine => ({ id, kind: 'whoami', tenant: 'T1', status: 200, seconds: 0.1, edgeTenant: 't1', at: 0, ...over });
  const row = (id: string, over: Partial<EdgeRow> = {}): EdgeRow => ({ id, status: 200, resultType: 'Miss', tenant: 't1', seconds: 0.05, ...over });

  it('joins on the request id and reports what is missing or different', () => {
    const rows = new Map([row('a'), row('b', { status: 403 }), row('c', { tenant: '-' })].map((r) => [r.id, r]));
    const j = joinEdge([line('a'), line('b'), line('c'), line('d'), line('', { kind: 'direct-origin' })], rows);
    expect(j).toMatchObject({ expected: 4, matched: 3, missing: 1 });
    expect(j.statusMismatches).toEqual(['whoami: client 200, edge log 403']);
    expect(j.tenantMismatches).toEqual(['whoami: expected tenant t1, edge log -']);
    expect(j.edgeSeconds).toEqual([0.05, 0.05, 0.05]);
  });

  it('does not compare the tenant where the router logs none, and checks router refusals are function generated', () => {
    const rows = new Map([row('a', { status: 403, resultType: 'FunctionGeneratedResponse', tenant: '' })].map((r) => [r.id, r]));
    const j = joinEdge([line('a', { kind: 'cross-site', status: 403, reason: 'edge-cross-site', edgeTenant: '' })], rows);
    expect(j).toMatchObject({ matched: 1, routerRefusals: 1, generatedByFunction: 1 });
    expect(j.tenantMismatches).toEqual([]);
  });

  it('counts what reached the cell by status and compares it with the cell log', () => {
    const lines = [line('a'), line('b'), line('c', { status: 403, reason: 'cell-forbidden' }), line('d', { status: 403, reason: 'edge-no-route' }), line('', { status: 403, reason: 'origin-iam-denied' })];
    const want = expectedAtCell(lines);
    expect([...want]).toEqual([[200, 2], [403, 1]]);
    expect(compareCell(want, new Map([[200, 2], [403, 1]]))).toEqual([]);
    expect(compareCell(want, new Map([[200, 2], [403, 2], [429, 1]]))).toEqual([
      'status 403: the driver saw 1 reach the cell, the cell logged 2',
      'status 429: the driver saw 0 reach the cell, the cell logged 1',
    ]);
  });
});

describe('tokens and ids', () => {
  const real = `${Buffer.from('{"alg":"RS256","kid":"k"}').toString('base64url')}.${Buffer.from('{"tenant_id":"AAA","sub":"u","iat":1,"exp":3601}').toString('base64url')}.sig`;

  it('makes ULID-shaped ids that sort by time', () => {
    const a = newUlid(1_700_000_000_000);
    const b = newUlid(1_700_000_001_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it('forges a payload that names another tenant and keeps the header and signature', () => {
    const forged = forgeToken(real, 'BBB');
    expect(payloadOf(forged)).toMatchObject({ tenant_id: 'BBB', sub: 'u' });
    expect(forged.split('.')[0]).toBe(real.split('.')[0]);
    expect(forged.split('.')[2]).toBe('sig');
  });

  it('pads a token to the size the router must handle, without passing it', () => {
    const large = `Bearer ${forgeToken(real, 'AAA', 8000)}`;
    expect(large.length).toBeLessThanOrEqual(8000);
    expect(large.length).toBeGreaterThan(7900);
    expect(`Bearer ${forgeToken(real, 'AAA', 8300)}`.length).toBeGreaterThan(8192);
  });

  it('builds a token no one signed whose payload names the tenant', () => {
    expect(payloadOf(unsignedToken('GHOST'))).toEqual({ tenant_id: 'GHOST' });
    expect(unsignedToken('GHOST').split('.')).toHaveLength(3);
  });
});

describe('signing Region', () => {
  it('takes the Region from the API Gateway host, so the registrar and tenant-identity may be in different Regions', () => {
    expect(regionOf('https://abcde12345.execute-api.eu-central-1.amazonaws.com/prod/', 'eu-west-2')).toBe('eu-central-1');
    expect(regionOf('https://example.org/x', 'eu-west-2')).toBe('eu-west-2');
  });

  afterEach(() => jest.restoreAllMocks());

  it('signs the query string it sends', async () => {
    const sent = jest.spyOn(http, 'request').mockResolvedValue({ status: 200, headers: {}, body: '', ttfb: 0, total: 0 });
    const caller = signedCaller('eu-west-2', async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret' }));
    const base = 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/prod/tenants';
    // Only the clock is fixed, so the two signatures differ by the query alone.
    jest.useFakeTimers({
      now: new Date('2026-11-21T10:00:00Z'),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'],
    });
    try {
      await caller.call('GET', `${base}?a=1`);
      await caller.call('GET', `${base}?a=2`);
    } finally {
      jest.useRealTimers();
    }
    expect(sent.mock.calls[0][0].headers?.authorization).not.toBe(sent.mock.calls[1][0].headers?.authorization);
  });

  it('signs a call for execute-api in the Region of the host with the credentials it is given', async () => {
    const sent = jest.spyOn(http, 'request').mockResolvedValue({ status: 200, headers: {}, body: '', ttfb: 0, total: 0 });
    const caller = signedCaller('eu-west-2', async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-session' }));
    await caller.call('PUT', 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/prod/tenants/T1', {});
    const o = sent.mock.calls[0][0];
    expect(o.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/execute-api\/aws4_request/);
    expect(o.headers?.['x-amz-security-token']).toBe('example-session');
    expect(o.headers?.['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(o.headers?.host).toBe('abcde12345.execute-api.eu-central-1.amazonaws.com');
    expect(o.headers?.['content-type']).toBe('application/json');
    expect(o.body).toBe('{}');
  });
});

describe('assumed role credentials', () => {
  const sts = mockClient(STSClient);
  const answer = (expiresInMs: number) => ({
    Credentials: { AccessKeyId: 'AKID', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: new Date(Date.now() + expiresInMs) }, // pragma: allowlist secret
  });

  beforeEach(() => sts.reset());
  afterEach(() => jest.restoreAllMocks());

  it('assumes the role once for concurrent callers, and again five minutes before the credentials expire', async () => {
    sts.on(AssumeRoleCommand).resolves(answer(3_600_000));
    const credentials = assumedCredentials('arn:aws:iam::123456789012:role/example', 'eu-west-2', 'example');
    const [a, b] = await Promise.all([credentials(), credentials()]);
    expect(a.accessKeyId).toBe('AKID');
    expect(b).toBe(a);
    await credentials();
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    const real = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(real + 3_600_000 - 5 * 60_000 + 1000);
    await credentials();
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it('rejects an answer with no credentials, and asks again on the next call', async () => {
    sts.on(AssumeRoleCommand).resolvesOnce({}).resolves(answer(3_600_000));
    const credentials = assumedCredentials('arn:aws:iam::123456789012:role/example', 'eu-west-2', 'example');
    await expect(credentials()).rejects.toThrow('returned no credentials');
    await expect(credentials()).resolves.toMatchObject({ accessKeyId: 'AKID' });
  });
});

describe('sweep', () => {
  const ssm = mockClient(SSMClient);
  let dir: string;
  const env = (): Env => ({ tier: parseTier(SMALL), runId: 'r', prefix: 'P', mode: 'slice', results: '', commit: '', region: 'eu-west-2', stateDir: dir });
  const outputs = Object.fromEntries(
    ['region', 'edgeRegion', 'accountId', 'appDomain', 'applicationId', 'registrarUrl', 'cellId', 'cellApiDomain', 'cellFunctionUrl', 'cellLogGroup', 'edgeLogGroup', 'routerFunction', 'fixtureTable', 'operatorRoleArn', 'hookRoleArn', 'identityApiUrl', 'identityAppClientId'].map((k) => [k, `https://example.invalid/${k}`]),
  );
  const reply = (status: number) => ({ status, headers: {}, body: '', ttfb: 0, total: 0 });
  const manifestFile = (): string => path.join(dir, 'manifest.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-sweep-'));
    fs.writeFileSync(path.join(dir, 'outputs.json'), JSON.stringify(outputs));
    fs.writeFileSync(manifestFile(), JSON.stringify({ version: 1, tenants: [{ tenantId: 'T1', username: 'u1', kind: 'active' }, { tenantId: 'T2', username: 'u2', kind: 'write' }] }));
    ssm.reset();
    ssm.on(DeleteParametersCommand).resolves({});
    jest.spyOn(http, 'sleep').mockResolvedValue(undefined);
    jest.spyOn(IdentityClient.prototype, 'deleteTenant').mockResolvedValue(200);
    jest.spyOn(Registrar.prototype, 'deleteCell').mockResolvedValue(reply(200));
  });

  afterEach(() => jest.restoreAllMocks());

  it('tries a busy registrar again, removes the manifest when everything went, and deletes the parameters', async () => {
    const answers = [503, 0, 200, 200];
    const del = jest.spyOn(Registrar.prototype, 'deleteTenant').mockImplementation(async () => reply(answers.shift() ?? 200));
    expect(await sweep(env(), true)).toBe(0);
    expect(del).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(manifestFile())).toBe(false);
    expect(ssm.commandCalls(DeleteParametersCommand)[0].args[0].input.Names).toHaveLength(2);
  });

  it('keeps the manifest when a route could not be deleted, and does not touch routes with --no-routes', async () => {
    const del = jest.spyOn(Registrar.prototype, 'deleteTenant').mockResolvedValue(reply(403));
    expect(await sweep(env(), true)).toBe(1);
    expect(fs.existsSync(manifestFile())).toBe(true);
    del.mockClear();
    expect(await sweep(env(), false)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(fs.existsSync(manifestFile())).toBe(false);
  });
});

describe('what the runner reads', () => {
  it('builds a record that the contract accepts, and a budget that parses', () => {
    const rec = new Recorder();
    const sink = new Sink(rec);
    sink.take({ kind: 'no-token', tenant: '-', edgeTenant: '-' }, { status: 401, headers: {}, body: '{"status":401}', ttfb: 0.01, total: 0.02 });
    sink.take({ kind: 'whoami', tenant: 'T1', expect: 'T1' }, { status: 200, headers: {}, body: '{"tenantId":"T1","routeHint":"t1"}', ttfb: 0.01, total: 0.05 });
    rec.tally('200:registrar-write');
    rec.hop('time-to-routable', 12.5);
    const record = rec.build({ runId: 'r1', tier: 'small', mode: 'slice', commit: '62c208f' }, 'edge-refusals');
    expect(recordProblems(record)).toEqual([]);
    expect(parseDraws('tenant-front-door', JSON.stringify({ draws: drawsOf(parseTier(SMALL)) }), 1)).toHaveLength(1);
  });
});

describe('load helpers', () => {
  it('paces calls at the rate and finishes them all', async () => {
    const started: number[] = [];
    const r = await paced(50, 0.2, async () => { started.push(Date.now()); });
    expect(r.started).toBe(10);
    expect(started).toHaveLength(10);
    expect(started[9] - started[0]).toBeGreaterThanOrEqual(150);
  });

  it('keeps at most the cap in flight', async () => {
    let now = 0;
    let peak = 0;
    await paced(1000, 0.02, async () => {
      now += 1;
      peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 15));
      now -= 1;
    }, 4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('runs the pool to the end and then rejects with the first error', async () => {
    const seen: number[] = [];
    await expect(pool([1, 2, 3, 4], 2, async (n) => {
      seen.push(n);
      if (n === 2) throw new Error('two');
    })).rejects.toThrow('two');
    expect(seen).toContain(1);
  });

  it('counts a call the in-flight cap held back for more than a second as late', async () => {
    const r = await paced(1000, 0.004, () => new Promise<void>((resolve) => setTimeout(resolve, 600)), 1);
    expect(r.started).toBe(4);
    expect(r.late).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('rejects with the first error of a paced call after the others settled', async () => {
    const done: number[] = [];
    await expect(
      paced(1000, 0.006, (i) => {
        // One call throws at once and one after a tick: neither is an unhandled rejection.
        if (i === 1) throw new Error('one');
        done.push(i);
        return i === 3 ? Promise.reject(new Error('three')) : Promise.resolve();
      }),
    ).rejects.toThrow('one');
    expect(done).toEqual([0, 2, 3, 4, 5]);
  });

  it('spaces a shared gate', async () => {
    const waits: number[] = [];
    jest.spyOn(http, 'sleep').mockImplementation(async (ms) => {
      waits.push(ms);
    });
    const gate = new Rate(50);
    await Promise.all([gate.take(), gate.take(), gate.take()]);
    jest.restoreAllMocks();
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(15);
    expect(waits[1]).toBeGreaterThan(waits[0] + 15);
  });

  it('retries a transient answer with a backoff and returns the last one', async () => {
    const answers = [503, 503, 200];
    const r = await retrying(async () => ({ status: answers.shift() as number, headers: {}, body: '', ttfb: 0, total: 0 }), (x) => x.status === 503, 5);
    expect(r.status).toBe(200);
    const still = await retrying(async () => ({ status: 503, headers: {}, body: '', ttfb: 0, total: 0 }), (x) => x.status === 503, 1);
    expect(still.status).toBe(503);
  }, 20_000);

  it('does not wait after its last attempt', async () => {
    const waits: number[] = [];
    jest.spyOn(http, 'sleep').mockImplementation(async (ms) => {
      waits.push(ms);
    });
    const r = await retrying(async () => ({ status: 503, headers: {}, body: '', ttfb: 0, total: 0 }), (x) => x.status === 503, 3);
    jest.restoreAllMocks();
    expect(r.status).toBe(503);
    expect(waits).toHaveLength(2);
  });

  it('names a registrar 503 by its cause', () => {
    const r = (body: string) => ({ status: 503, headers: {}, body, ttfb: 0, total: 0 });
    expect(registrarCause(r('{"message":"the route table is busy; retry"}'))).toBe('route-table-busy');
    expect(registrarCause(r('{"message":"the control plane could not be read"}'))).toBe('control-plane-unreadable');
    expect(registrarCause(r('{}'))).toBe('other');
  });
});

describe('watching a written route', () => {
  const answer = (status: number) => ({
    status,
    headers: {},
    body: status === 200 ? '{"tenantId":"T1","routeHint":"t1"}' : '{"status":403}',
    ttfb: 0,
    total: 0.01,
  });

  async function watch(statuses: number[], seconds: number): Promise<{ w: Watch; rec: Recorder }> {
    const queue = [...statuses];
    // A clock that moves one millisecond per reading, so the window holds a fixed number of requests whatever the host does.
    let clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
    jest.spyOn(http, 'request').mockImplementation(async () => answer(queue.shift() ?? 200));
    jest.spyOn(http, 'sleep').mockResolvedValue(undefined);
    const rec = new Recorder();
    const w: Watch = { tenantId: 'T1', flaps: 0, finalMisses: 0 };
    await watchRoute({ out: { appDomain: 'app.example.com' } } as never, new Sink(rec), w, () => 'tok', seconds);
    return { w, rec };
  }

  afterEach(() => jest.restoreAllMocks());

  it('counts a request that misses the route after the watch window', async () => {
    const { w, rec } = await watch([403, 200, 403, 200, 200], 0);
    expect(w.finalMisses).toBe(2);
    expect(rec.count('403:edge-no-route')).toBe(2);
    expect(rec.counts.assertions).toBe(8);
  });

  it('notes the first request that is routed and a miss after it', async () => {
    const { w } = await watch([403, 403, 200, 403, 200], 0.05);
    expect(w.firstRoutable).toBeGreaterThanOrEqual(0);
    expect(w.lastMiss).toBeDefined();
    expect(w.flaps).toBe(1);
    expect(w.finalMisses).toBe(0);
  });
});

describe('the registrar answer to a write', () => {
  it('writes on 200, tries again on 503 and names its cause, and calls anything else a finding', () => {
    expect(writeAnswer({ status: 200, body: '{}' })).toEqual({ written: true, retry: false, reason: '' });
    expect(writeAnswer({ status: 503, body: '{"message":"the route table is busy; retry"}' })).toEqual({ written: false, retry: true, reason: 'registrar-route-table-busy' });
    expect(writeAnswer({ status: 503, body: '{"message":"the control plane could not be read"}' }).reason).toBe('registrar-control-plane-unreadable');
    expect(writeAnswer({ status: 403, body: '{}' })).toMatchObject({ written: false, retry: false, reason: 'registrar-refused', violation: expect.stringContaining('HTTP 403') });
    expect(writeAnswer({ status: 0, body: '' })).toMatchObject({ reason: 'registrar-network', violation: expect.stringContaining('no answer') });
  });
});

describe('edge log rows', () => {
  const row = (fields: Record<string, string>): { field: string; value: string }[] =>
    Object.entries(fields).map(([field, value]) => ({ field, value }));

  it('keeps the rows with a numeric status and time, and returns the ids of the others', async () => {
    const results = [
      row({ id: 'a', status: '200', resultType: 'Miss', tenant: 't1', seconds: '0.25' }),
      row({ id: 'b', status: '200', resultType: 'Miss', tenant: 't1', seconds: '-' }),
      row({ id: 'c', status: '', resultType: 'Miss', tenant: 't1', seconds: '0.1' }),
    ];
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        return command.constructor.name === 'StartQueryCommand' ? { queryId: 'q' } : { status: 'Complete', results };
      },
    };
    const rows = new Map<string, EdgeRow>();
    const skipped = new Set<string>();
    await loadEdgeRows(client as never, 'group', 0, 1000, 60, rows, skipped);
    expect([...rows.keys()]).toEqual(['a']);
    expect(rows.get('a')).toMatchObject({ status: 200, seconds: 0.25 });
    expect([...skipped].sort()).toEqual(['b', 'c']);
  });
});
