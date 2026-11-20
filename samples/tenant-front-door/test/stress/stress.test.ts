// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { classify, EXPECT, meets, type RequestKind } from './classify';
import { forgeToken, newUlid, payloadOf, unsignedToken } from './clients';
import { compareCell, expectedAtCell, joinEdge, type EdgeRow } from './join';
import { drawsOf, parseTier, planOf, tenantsToSeed } from './plan';
import { percentiles, Recorder } from './recorder';
import { Sink, answerOf } from './sink';
import type { RequestLine } from './state';

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
  const line = (id: string, over: Partial<RequestLine> = {}): RequestLine => ({ id, kind: 'whoami', tenant: 'T1', status: 200, seconds: 0.1, edgeTenant: 't1', ...over });
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
  it('takes the Region from the API Gateway host, so the registrar and tenant-identity may be in different Regions', async () => {
    const { regionOf } = await import('./sigv4');
    expect(regionOf('https://abcde12345.execute-api.eu-central-1.amazonaws.com/prod/', 'eu-west-2')).toBe('eu-central-1');
    expect(regionOf('https://example.org/x', 'eu-west-2')).toBe('eu-west-2');
  });
});
