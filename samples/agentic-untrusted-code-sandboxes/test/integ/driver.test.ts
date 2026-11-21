// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentRequestBody, ensureScope } from './agent-path';
import { EVIDENCE_LINE_CHARS, EVIDENCE_LINES, evidenceLines } from './cloud';
import { DEFAULT_DEPLOY_CONCURRENCY, deployConcurrency, runRegion, stackPrefix } from './common';
import { Ctx, TOKEN_REUSE_MS } from './ctx';
import { imageNameOf } from './deploy';
import { HOSTILE_DIR, MAX_CODE_BYTES, PROBES, probeCode } from './hostile';
import { checkLeftovers, namesLogGroup, newPolicyFindings, policyFindings, serviceLogPrefixes } from './leftovers';
import { claimsFor, mint, signJws } from './mint.function';
import { formatRecord, median, Recorder } from './record';
import { runPhase } from './runner';
import { canonicalPath, presignUrl, signRequest } from './sigv4';
import { matrix, SPEC_TABLE_ORDER, STEPS, unitKey, validateSteps, type StepSpec } from './steps';
import { collectHandles, sameKeys } from './steps/basic';
import { neededQuotaGb, slotsFree } from './steps/build';
import { DRIVER_STEPS, IMPLS } from './steps/index';
import { CONNECTED, LAMBDA_RESPONSE_BYTES, LOOKUP_SLOW, PROBE_BOUND_MS, controlAnswered, controlOutputOk, denied, egressFailed, noConnection, reverseName, unexpectedBlocked } from './steps/probes';
import { lastJsonLine, parseFunctionResponse, parseGatewayResponse } from './tool-result';

describe('step order and matrix', () => {
  test('the step list is sound', () => {
    expect(validateSteps()).toEqual([]);
  });

  test('every spec table step is run, and nothing else is', () => {
    expect([...STEPS.map((s) => s.name)].sort()).toEqual([...SPEC_TABLE_ORDER].sort());
  });

  test('the run order is not the table order (the document says so)', () => {
    expect(STEPS.map((s) => s.name)).not.toEqual([...SPEC_TABLE_ORDER]);
  });

  test('every step has an implementation, or is one the driver runs around the deploy', () => {
    const names = STEPS.map((s) => s.name);
    expect(names.filter((n) => IMPLS[n] === undefined).sort()).toEqual([...DRIVER_STEPS].sort());
  });

  test('a step before its dependency is reported', () => {
    const swapped = [...STEPS];
    const i = swapped.findIndex((s) => s.name === 'reuse');
    [swapped[i], swapped[i - 1]] = [swapped[i - 1], swapped[i]];
    expect(validateSteps(swapped).join(' ')).toMatch(/reuse runs before parse|parse runs before reuse|runs before/);
  });

  test('the teardown must come last, and a missing step is reported', () => {
    expect(validateSteps(STEPS.slice(0, -1)).join(' ')).toMatch(/teardown/);
  });

  test('a step on a backend its instance does not enable is reported', () => {
    const bad: StepSpec[] = [{ name: 'x', phase: 'after-deploy', instances: ['run-code-files'], backends: ['nitro'], after: [] }];
    expect(validateSteps(bad, ['x']).join(' ')).toMatch(/does not enable it/);
  });

  test('the matrix runs per-backend steps once per backend, dns and teardown also on the files instance', () => {
    const units = matrix().map(unitKey);
    expect(units).toContain('parse:run-code:microvm');
    expect(units).toContain('parse:run-code:agentcore');
    expect(units.filter((u) => u.startsWith('parse:'))).toHaveLength(3);
    expect(units.filter((u) => u.startsWith('dns:'))).toEqual(['dns:run-code:microvm', 'dns:run-code:nitro', 'dns:run-code:agentcore', 'dns:run-code-files:agentcore']);
    expect(units.filter((u) => u.startsWith('teardown:'))).toHaveLength(4);
    expect(units.filter((u) => u.startsWith('offboard'))).toEqual(['offboard:run-code']);
    expect(units).toHaveLength(59);
    expect(units).toContain('session-files:run-code-files:agentcore');
    expect(units.filter((u) => u.startsWith('failed-start:'))).toEqual(['failed-start:run-code:nitro', 'failed-start:run-code:microvm']);
    expect(units).toContain('iam-wall:run-code');
    expect(units).toContain('forged:run-code');
  });
});

describe('the runner', () => {
  test('runs every unit of the phase in order, records a crash and goes on', async () => {
    const rec = new Recorder('r', () => 0, () => undefined);
    const seen: string[] = [];
    const impls = {
      parse: async (_c: unknown, u: { backend?: string }) => {
        seen.push(`parse:${u.backend}`);
        if (u.backend === 'nitro') throw new Error('boom');
        rec.check('fine', true);
      },
    };
    await runPhase(rec, {}, STEPS.filter((s) => s.name === 'parse'), 'after-deploy', impls);
    expect(seen).toEqual(['parse:microvm', 'parse:nitro', 'parse:agentcore']);
    const r = rec.toJSON('t');
    expect(r.steps.map((s) => s.result)).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(r.steps[1].evidence).toMatch(/step crashed: Error: boom/);
  });

  test('a stopped run skips every remaining unit', async () => {
    const rec = new Recorder('r', () => 0, () => undefined);
    const seen: string[] = [];
    const impls = { parse: async () => void seen.push('x') };
    await runPhase(rec, {}, STEPS.filter((s) => s.name === 'parse'), 'after-deploy', impls, () => true);
    expect(seen).toEqual([]);
    expect(rec.toJSON('t').steps.map((x) => x.result)).toEqual(['SKIP', 'SKIP', 'SKIP']);
  });

  test('a unit with no implementation is skipped, not passed', async () => {
    const rec = new Recorder('r', () => 0, () => undefined);
    await runPhase(rec, {}, STEPS.filter((s) => s.name === 'forged'), 'after-deploy', {});
    expect(rec.toJSON('t').steps[0].result).toBe('SKIP');
  });
});

describe('the context', () => {
  const make = () => new Ctx({} as never, new Recorder('r', () => 0, () => undefined), 'S', { MintFunction: 'm' }, 'run');

  test('a revoked tenant gets no token, and a stopped run gets none at all', async () => {
    const c = make();
    c.revoke('C');
    await expect(c.token('run-code', 'C')).rejects.toThrow(/no longer mints tokens for tenant C/);
    c.aborted = true;
    await expect(c.token('run-code', 'A')).rejects.toThrow(/run was stopped/);
    await expect(c.call('run-code', 'A', { code: 'x' })).rejects.toThrow(/run was stopped/);
  });

  test('a cached token is reused, and revoking the tenant drops it', async () => {
    const send = jest.fn(async () => ({ Payload: Buffer.from(JSON.stringify({ token: 'a.b.c' })) }));
    const c = new Ctx({ lambda: { send } } as never, new Recorder('r', () => 0, () => undefined), 'S', { MintFunction: 'm' }, 'run');
    expect(await c.token('run-code', 'C')).toBe('a.b.c');
    expect(await c.token('run-code', 'C')).toBe('a.b.c');
    expect(send).toHaveBeenCalledTimes(1);
    c.revoke('C');
    await expect(c.token('run-code', 'C')).rejects.toThrow(/no longer mints/);
    expect(await c.token('run-code', 'B')).toBe('a.b.c');
  });

  test('a call that retries a starting sandbox takes a fresh token once the reused one is too old', async () => {
    let n = 0;
    const send = jest.fn(async () => ({ Payload: Buffer.from(JSON.stringify({ token: `t.${++n}.x` })) }));
    const c = new Ctx({ lambda: { send } } as never, new Recorder('r', () => 0, () => undefined), 'S', { MintFunction: 'm', ToolsGatewayUrl: 'https://gw.invalid/' }, 'run');
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    expect(await c.token('run-code', 'A')).toBe('t.1.x');
    now += TOKEN_REUSE_MS - 1;
    expect(await c.token('run-code', 'A')).toBe('t.1.x');
    now += 2;
    expect(await c.token('run-code', 'A')).toBe('t.2.x');
    clock.mockRestore();
  });

  test('a leftover check of a run that stopped before its resources were recorded reports the new policy', async () => {
    const aws = {
      cfn: { send: async () => ({ Stacks: [] }) },
      logs: { send: async () => ({ resourcePolicies: [{ policyName: 'fresh', policyDocument: 'x' }] }) },
    };
    const state = { prefix: 'P', region: 'r', stackName: 'P', startedAt: 't', destroyed: false, resources: [], policyBaseline: {}, runtimeNames: [], imageNames: [] };
    const found = await checkLeftovers(aws as never, 'P', state);
    expect(found.map((f) => f.id)).toEqual(['fresh']);
  });

  test('a blank image name in the run state is reported as a check that failed, and no log group is listed with an empty prefix', async () => {
    const prefixes: Array<string | undefined> = [];
    const aws = {
      cfn: { send: async () => ({ Stacks: [] }) },
      logs: {
        send: async (cmd: { input: { logGroupNamePrefix?: string } }) => {
          if ('logGroupNamePrefix' in cmd.input) prefixes.push(cmd.input.logGroupNamePrefix);
          return { logGroups: [], resourcePolicies: [] };
        },
      },
    };
    const state = { prefix: 'P', region: 'r', stackName: 'P', startedAt: 't', destroyed: false, resources: [], policyBaseline: {}, runtimeNames: [], imageNames: ['', 'img'] };
    const found = await checkLeftovers(aws as never, 'P', state);
    expect(found).toEqual([{ kind: 'check-failed', id: 'image', detail: expect.stringMatching(/empty service name/) }]);
    expect(prefixes).toEqual(['/aws/lambda-microvms/img']);
  });
});

describe('the consumer path and the evidence', () => {
  const api = 'https://id.example.com/prod/';
  test('the app/use scope is registered when tenant-identity answers 404, and left alone when it exists', async () => {
    const calls: string[] = [];
    const send = (status: Record<string, number>) => async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      return { status: status[method] };
    };
    expect(await ensureScope(send({ GET: 404, PUT: 200 }), api, 'r1')).toEqual({ registered: true, status: 200 });
    expect(calls).toEqual([`GET ${api}platform/scopes/app%2Fuse`, `PUT ${api}platform/scopes/app%2Fuse`]);
    expect(await ensureScope(send({ GET: 200 }), api, 'r1')).toEqual({ status: 200 });
    expect(calls.slice(2)).toEqual([`GET ${api}platform/scopes/app%2Fuse`]);
    expect(await ensureScope(send({ GET: 404, PUT: 500 }), api, 'r1')).toEqual({ registered: false, status: 500 });
    // never a delete: the shared pool keeps the scope
    expect(calls.some((x) => x.startsWith('DELETE'))).toBe(false);
  });
  test('the agent call sends only the prompt (the ingress model has additionalProperties false and no session scope)', () => {
    expect(JSON.parse(agentRequestBody('tool x/y {}'))).toEqual({ prompt: 'tool x/y {}' });
  });
  test('evidence keeps the last lines, each cut to size, on one line', () => {
    const lines = evidenceLines(Array.from({ length: EVIDENCE_LINES + 5 }, (_, i) => `line ${i}\n${'y'.repeat(EVIDENCE_LINE_CHARS)}`));
    expect(lines).toHaveLength(EVIDENCE_LINES);
    expect(lines[0].startsWith('line 5 ')).toBe(true);
    expect(lines.every((l) => l.length <= EVIDENCE_LINE_CHARS && !l.includes('\n'))).toBe(true);
  });
  test('a failed unit keeps its notes in the record', () => {
    const rec = new Recorder('r', () => 0, () => undefined);
    rec.begin('race:run-code:agentcore');
    rec.note('runner lines: x');
    rec.check('both calls served', false);
    rec.end();
    expect(rec.toJSON('t').steps[0].evidence).toBe('both calls served; runner lines: x');
  });
});

describe('the run record', () => {
  test('a failed check marks the step, the run fails, timings and latency are tabulated', async () => {
    let t = 0;
    const rec = new Recorder('eu-central-1', () => (t += 1000), () => undefined);
    rec.begin('a');
    rec.check('ok', true);
    rec.note('seen');
    rec.begin('b');
    rec.check('broken | pipe', false);
    rec.skip('c', 'why');
    await rec.time('deploy', async () => undefined);
    rec.latency('microvm', 'cold', 2800);
    rec.latency('microvm', 'warm', 300);
    rec.latency('microvm', 'warm', 100);
    expect(rec.failed).toBe(true);
    const r = rec.toJSON('2026-01-01T00:00:00Z');
    expect(r.steps.map((s) => s.result)).toEqual(['PASS', 'FAIL', 'SKIP']);
    expect(median(r.latency, 'microvm', 'warm')).toBe(100);
    const text = formatRecord(r);
    expect(text).toContain('1 of 3 steps passed, 1 skipped');
    expect(text).toContain('| deploy | 1 |');
    expect(text).toContain('| microvm | 2800 | 100 |');
    expect(text).toContain('broken / pipe');
  });
});

describe('knobs', () => {
  test('the deploy concurrency defaults to 2 and is checked', () => {
    expect(deployConcurrency({})).toBe(DEFAULT_DEPLOY_CONCURRENCY);
    expect(DEFAULT_DEPLOY_CONCURRENCY).toBe(2);
    expect(deployConcurrency({ INTEG_DEPLOY_CONCURRENCY: '4' })).toBe(4);
    expect(() => deployConcurrency({ INTEG_DEPLOY_CONCURRENCY: '0' })).toThrow(/positive integer/);
  });

  test('the Region is required and the prefix is checked', () => {
    expect(() => runRegion({})).toThrow(/AWS_REGION/);
    expect(runRegion({ AWS_REGION: 'eu-central-1' })).toBe('eu-central-1');
    expect(stackPrefix({})).toBe('UntrustedCodeSandboxesInteg');
    expect(() => stackPrefix({ INTEG_PREFIX: '1bad' })).toThrow(/letters and digits/);
  });

  test('the MicroVM quota needed is 5 sandboxes of the default size', () => {
    expect(neededQuotaGb()).toBe(5);
    expect(neededQuotaGb(2048)).toBe(10);
  });
});

describe('reading a tool answer', () => {
  const result = { runId: 'r', backend: 'microvm', exitCode: 0, stdout: 'x', stderr: '', truncated: false, timedOut: false, memoryExceeded: false, durationMs: 5, sandbox: 'started' };
  const rpc = (text: string, isError = false) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError } });

  test('gateway: a result, an error code with a retry time, plain text naming a code, a refusal', () => {
    expect(parseGatewayResponse(200, rpc(JSON.stringify(result)))).toMatchObject({ kind: 'result', result: { exitCode: 0, sandbox: 'started' } });
    expect(parseGatewayResponse(200, rpc(JSON.stringify({ code: 'sandbox_starting', retryAfterSeconds: 7 }), true))).toEqual({ kind: 'error', code: 'sandbox_starting', retryAfterSeconds: 7 });
    expect(parseGatewayResponse(200, rpc('input_too_large: the object is over the limit', true))).toMatchObject({ kind: 'error', code: 'input_too_large' });
    expect(parseGatewayResponse(403, '{"message":"x"}')).toEqual({ kind: 'refused', status: 403 });
    expect(parseGatewayResponse(200, 'not json')).toEqual({ kind: 'unreadable' });
  });

  test('the tool\'s own error field carries the code, in text or as structured content', () => {
    const structured = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { error: 'sandbox_busy', retryAfterSeconds: 2 }, isError: true } });
    expect(parseGatewayResponse(200, structured)).toEqual({ kind: 'error', code: 'sandbox_busy', retryAfterSeconds: 2 });
    expect(parseFunctionResponse(undefined, JSON.stringify({ error: 'sandbox_failed', retryAfterSeconds: 9 }))).toEqual({ kind: 'error', code: 'sandbox_failed', retryAfterSeconds: 9 });
  });

  test('gateway: an event-stream body is read too', () => {
    expect(parseGatewayResponse(200, `event: message\ndata: ${rpc(JSON.stringify(result))}\n\n`)).toMatchObject({ kind: 'result' });
  });

  test('function: a result, a Lambda error payload with a code, a nested error', () => {
    expect(parseFunctionResponse(undefined, JSON.stringify(result))).toMatchObject({ kind: 'result' });
    expect(parseFunctionResponse('Unhandled', JSON.stringify({ errorType: 'ToolError', errorMessage: 'invalid_argument: tenantId' }))).toMatchObject({ kind: 'error', code: 'invalid_argument' });
    expect(parseFunctionResponse(undefined, JSON.stringify({ error: { code: 'tool_failed' } }))).toMatchObject({ kind: 'error', code: 'tool_failed' });
    expect(parseFunctionResponse(undefined, JSON.stringify({ code: 'weird' }))).toMatchObject({ kind: 'error', code: 'unknown' });
  });

  test('the last JSON line of stdout is the probe output', () => {
    expect(lastJsonLine('noise\n{"a":1}\nmore\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJsonLine('no json')).toBeUndefined();
  });

  test('offboard handles are counted per array element', () => {
    expect(collectHandles(JSON.stringify({ tenantId: 'C', stopped: [{ backend: 'nitro', handle: 'h1' }, 'h2'] }))).toHaveLength(2);
    expect(collectHandles(JSON.stringify({ stopped: [] }))).toEqual([]);
    expect(collectHandles('not json')).toEqual([]);
    expect(sameKeys('{"a":1,"b":[]}', '{"b":[],"a":2}')).toBe(true);
    expect(sameKeys('{"a":1}', '{"a":1,"c":1}')).toBe(false);
  });
});

describe('SigV4', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2015-08-30T12:36:00Z');

  test('matches the AWS test-suite case get-vanilla', () => {
    const h = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', credentials, now });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });

  test('the canonical path encodes a segment once for S3 and twice for the rest, `+` and `@` included', () => {
    expect(canonicalPath('/', 'execute-api')).toBe('/');
    expect(canonicalPath('/a+b/x@y', 's3')).toBe('/a%2Bb/x%40y');
    expect(canonicalPath('/a+b/x@y', 'execute-api')).toBe('/a%252Bb/x%2540y');
    expect(canonicalPath('/a%2Bb', 's3')).toBe('/a%2Bb');
  });

  test('a presigned URL carries the signed query and changes with the key', () => {
    const a = presignUrl({ method: 'PUT', url: 'https://b.s3.eu-central-1.amazonaws.com/k', region: 'eu-central-1', service: 's3', credentials, expiresSeconds: 300, now });
    const b = presignUrl({ method: 'PUT', url: 'https://b.s3.eu-central-1.amazonaws.com/k2', region: 'eu-central-1', service: 's3', credentials, expiresSeconds: 300, now });
    expect(new URL(a).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(new URL(a).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new URL(a).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(a).searchParams.get('X-Amz-Signature')).not.toBe(new URL(b).searchParams.get('X-Amz-Signature'));
  });
});

describe('the test mint', () => {
  test('claims match the ingress token: audiences, subject, act', () => {
    const c = claimsFor({ tenantId: 'A', sub: 's', agent: 'default', scope: 'run-code/run_code', gateways: ['default', 'default'] }, { issuer: 'https://i', ingressRoleArn: 'arn:role' }, 100, { txn: 't', jti: 'j' });
    expect(c).toMatchObject({ iss: 'https://i', sub: 'A#s', tenant_id: 'A', aud: ['agent:default', 'tools-gateway:default'], act: { sub: 'arn:role' }, iat: 100, exp: 400 });
  });

  test('a token is a compact JWS over the digest the signer saw, and a forged context carries the context type', async () => {
    process.env.RC_INTEG_ISSUER = 'https://i';
    process.env.RC_INTEG_KEY_ID = 'kid1';
    process.env.RC_INTEG_INGRESS_ROLE_ARN = 'arn:role';
    const signer = async () => Buffer.from('sig');
    const t = await mint({ tenantId: 'A', sub: 's', agent: 'default', scope: 'x', gateways: ['default'] }, signer, 1_000_000);
    const [h, p, s] = (t.token ?? '').split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'txn+jwt', kid: 'kid1' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ tenant_id: 'A', exp: 1300 });
    expect(Buffer.from(s, 'base64url').toString()).toBe('sig');
    const f = await mint({ tenantId: 'A', sub: 's', agent: 'default', scope: '', gateways: [], forgeContext: { tenantId: 'F', tool: 'run-code/run_code' } }, signer, 1_000_000);
    expect(JSON.parse(Buffer.from((f.context ?? '').split('.')[0], 'base64url').toString()).typ).toBe('ri-ctx+jwt');
    expect(await signJws('x', 'k', {}, signer)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe('the leftover comparison', () => {
  const arn = 'arn:aws:logs:r:acct:log-group:q';
  const cdkArn = `${arn}:*`;
  test('a CDK log group ARN (ending in :*) matches a delivery statement that names the group, a stream or :*', () => {
    expect(namesLogGroup(`{"Resource":"${arn}:log-stream:*"}`, cdkArn)).toBe(true);
    expect(namesLogGroup(`{"Resource":"${arn}"}`, cdkArn)).toBe(true);
    expect(namesLogGroup(`{"Resource":"${arn}:*"}`, cdkArn)).toBe(true);
    expect(namesLogGroup(`{"Resource":"${arn}-other:*"}`, cdkArn)).toBe(false);
    expect(namesLogGroup('{"Resource":"*"}', cdkArn)).toBe(false);
  });
  test('a statement in a policy the stack did not own is the known leftover, new or old', () => {
    const f = policyFindings({ shared: 'd1' }, [{ name: 'shared', document: `x ${arn}:* y` }, { name: 'made', document: arn }, { name: 'other', document: 'nothing' }], cdkArn);
    expect(f.map((x) => [x.id, x.known])).toEqual([['shared', true], ['made', true]]);
  });
  test('a run that stopped before its resources were recorded reports every policy that is new since the baseline', () => {
    const same = createHash('sha256').update('doc').digest('hex').slice(0, 16);
    const f = newPolicyFindings({ old: same, shared: 'other' }, [{ name: 'old', document: 'doc' }, { name: 'fresh', document: 'x' }, { name: 'shared', document: 'changed' }]);
    expect(f.map((x) => [x.id, x.known])).toEqual([['fresh', undefined], ['shared', true]]);
  });
  test('the stack\'s own policy is a plain leftover, and no ARN means nothing to compare', () => {
    expect(policyFindings({}, [{ name: 'mine', document: arn }], cdkArn, new Set(['mine']))[0].known).toBeUndefined();
    expect(policyFindings({}, [{ name: 'mine', document: arn }], undefined)).toEqual([]);
  });
  test('the image name is the last part of the image ARN, and a bare name is kept', () => {
    expect(imageNameOf('arn:aws:lambda:eu-west-1:ACCOUNT:microvm-image:some-image')).toBe('some-image');
    expect(imageNameOf('some-image')).toBe('some-image');
  });
  test('a blank runtime or image name gives no log group prefix, so nothing outside the run is listed', () => {
    expect(serviceLogPrefixes({ runtimeNames: ['rt', ''], imageNames: [' ', 'img'] })).toEqual([
      { kind: 'runtime', prefix: '/aws/bedrock-agentcore/runtimes/rt-' },
      { kind: 'runtime', prefix: undefined },
      { kind: 'image', prefix: undefined },
      { kind: 'image', prefix: '/aws/lambda-microvms/img' },
    ]);
    expect(serviceLogPrefixes({ runtimeNames: [], imageNames: [] })).toEqual([]);
  });
});

describe('the dns-platform check (spec 3.9)', () => {
  const none = new Set<string>();
  test('a PTR for the querying sandbox\'s own address is ignored', () => {
    expect(unexpectedBlocked([{ query_name: '187.13.0.10.in-addr.arpa.', query_type: 'PTR', srcaddr: '10.0.13.187' }], none)).toEqual([]);
  });
  test('a PTR for another address, another type or another name still fails', () => {
    expect(unexpectedBlocked([{ query_name: '188.13.0.10.in-addr.arpa.', query_type: 'PTR', srcaddr: '10.0.13.187' }], none)).toEqual(['188.13.0.10.in-addr.arpa']);
    expect(unexpectedBlocked([{ query_name: '187.13.0.10.in-addr.arpa.', query_type: 'A', srcaddr: '10.0.13.187' }], none)).toEqual(['187.13.0.10.in-addr.arpa']);
    expect(unexpectedBlocked([{ query_name: 'evil.example.net.', query_type: 'PTR', srcaddr: '10.0.13.187' }], none)).toEqual(['evil.example.net']);
    expect(unexpectedBlocked([{ query_name: '187.13.0.10.in-addr.arpa.', query_type: 'PTR' }], none)).toEqual(['187.13.0.10.in-addr.arpa']);
  });
  test('a malformed address, a suffixed or mixed-case name and a lowercase type are handled', () => {
    expect(reverseName('10.0.13.999')).toBeUndefined();
    expect(reverseName('10.0.013.1')).toBeUndefined();
    expect(reverseName('::1')).toBeUndefined();
    expect(reverseName('')).toBeUndefined();
    expect(reverseName('10.0.13.187')).toBe('187.13.0.10.in-addr.arpa');
    expect(unexpectedBlocked([{ query_name: '999.13.0.10.in-addr.arpa.', query_type: 'PTR', srcaddr: '10.0.13.999' }], none)).toEqual(['999.13.0.10.in-addr.arpa']);
    expect(unexpectedBlocked([{ query_name: 'x.187.13.0.10.in-addr.arpa.', query_type: 'PTR', srcaddr: '10.0.13.187' }], none)).toEqual(['x.187.13.0.10.in-addr.arpa']);
    expect(unexpectedBlocked([{ query_name: '187.13.0.10.in-addr.arpa.', query_type: 'ptr', srcaddr: '10.0.13.187' }], none)).toEqual(['187.13.0.10.in-addr.arpa']);
    expect(unexpectedBlocked([{ query_name: '187.13.0.10.IN-ADDR.ARPA', query_type: 'PTR', srcaddr: '10.0.13.187' }], none)).toEqual([]);
  });
  test('a name from several addresses is listed once', () => {
    const rows = [1, 2].map((i) => ({ query_name: 'evil.example.net.', query_type: 'A', srcaddr: `10.0.1.${i}` }));
    expect(unexpectedBlocked(rows, none)).toEqual(['evil.example.net']);
  });
  test('a looked-up name and the NTP zone stay ignored', () => {
    expect(unexpectedBlocked([{ query_name: 'a.example.com.', query_type: 'A', srcaddr: '10.0.1.1' }, { query_name: '0.amazon.pool.ntp.org.', query_type: 'A', srcaddr: '10.0.1.1' }], new Set(['a.example.com']))).toEqual([]);
  });
});

describe('the hostile probes', () => {
  test('every probe has a file, carries the MIT-0 header, and builds under the code limit', () => {
    const files = readdirSync(HOSTILE_DIR).filter((f) => f.endsWith('.py') && f !== '_lib.py').map((f) => f.replace('.py', '')).sort();
    expect(files).toEqual([...PROBES].sort());
    for (const p of PROBES) {
      const code = probeCode(p, { region: 'r', bucket: 'b', table: 't', backend: 'microvm', tenant: 'A', other: 'B', mode: 'x' });
      expect(Buffer.byteLength(code)).toBeLessThan(MAX_CODE_BYTES);
      expect(code.startsWith('import json\nCONFIG = json.loads(')).toBe(true);
    }
  });

  test('every probe compiles as Python 3 (the runner uses python3 -I -S)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-probes-'));
    for (const p of PROBES) {
      const file = path.join(dir, `${p}.py`);
      writeFileSync(file, probeCode(p, { mode: 'x', names: [] }));
      execFileSync('python3', ['-I', '-S', '-B', '-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', file]);
    }
  });

  test('the parse probe runs on a local copy of the input and prints its findings last', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-parse-'));
    const code = probeCode('parse').replace('/work/input', path.join(dir, 'input'));
    writeFileSync(path.join(dir, 'input'), 'tenant,id,amount\nA,1,10.50\nA,2,20.25\nA,3,5.00\n');
    const out = execFileSync('python3', ['-I', '-S', '-B', '-c', code], { encoding: 'utf8' });
    expect(lastJsonLine(out)).toEqual({ owner: 'A', rows: 3, total: 35.75 });
  });

  test('the DNS parser skips a name that ends in a pointer, and the config may hold true, false and null', () => {
    const code = probeCode('dns', { names: [], on: true, off: false, none: null });
    const run = (extra: string): string => execFileSync('python3', ['-I', '-S', '-B', '-c', `${code}\n${extra}`], { encoding: 'utf8' }).trim().split('\n').pop() ?? '';
    expect(run('print(skip_name(bytes([3,97,98,99,192,12]), 0))')).toBe('6');
    expect(run('print(skip_name(bytes([1,97,0]), 0))')).toBe('3');
    expect(run('print(CONFIG["on"], CONFIG["off"], CONFIG["none"])')).toBe('True False None');
  });

  test('the no-credentials and no-egress probes stay inside the 20 s run timeout when every request hangs', () => {
    // A sandbox with no route: urlopen never answers, and every connect takes 2 s and fails. Each address of a name
    // gets its 2 s (at most four), the requests run side by side, and the script prints by its shared deadline.
    const hang = 'import time, socket, urllib.request\nurllib.request.urlopen = lambda *a, **k: time.sleep(60)\ndef blocked(*a):\n    time.sleep(2)\n    raise socket.timeout()\nsocket.socket.connect = blocked\n';
    const config = { region: 'r', bucket: 'b', table: 't', backend: 'nitro', tenant: 'A', other: 'B', presigned: 'https://example.com/x', public_ip: '192.0.2.1' };
    for (const [probe, field] of [['nocreds', 'get_object_b'], ['noegress', 'https_name']] as const) {
      const t0 = Date.now();
      const out = execFileSync('python3', ['-I', '-S', '-B', '-c', hang + probeCode(probe, config)], { encoding: 'utf8', timeout: 25_000 });
      expect(Date.now() - t0).toBeLessThan(18_000);
      const seen = lastJsonLine(out) as Record<string, { error?: string; status?: unknown; outcome?: unknown; ms?: number }>;
      expect(seen[field].error).toBeDefined();
      expect(seen[field].status ?? seen[field].outcome).toBeUndefined();
      for (const v of Object.values(seen)) if (typeof v === 'object' && v !== null && v.ms !== undefined) expect(v.ms).toBeLessThan(PROBE_BOUND_MS + 500);
    }
  });

  test('a request whose connect completes is never read as blocked, however slow; a connect that does not complete is', () => {
    const lib = `CONFIG = {}\n${readFileSync(path.join(HOSTILE_DIR, '_lib.py'), 'utf8')}`;
    const script = [
      'def kind(url, t=1):',
      '    try:',
      '        http("GET", url, timeout=t)',
      '        return "answered"',
      '    except BaseException as e:',
      '        return type(e).__name__',
      'srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(8)',
      'print(kind("http://127.0.0.1:%d/" % srv.getsockname()[1]))',
      'gone = socket.socket(); gone.bind(("127.0.0.1", 0)); port = gone.getsockname()[1]; gone.close()',
      'print(kind("http://127.0.0.1:%d/" % port))',
      'socket.socket.connect = lambda *a: time.sleep(5)',
      't0 = time.time(); print(kind("http://127.0.0.1:%d/" % port)); print(time.time() - t0 < 2)',
    ].join('\n');
    const lines = execFileSync('python3', ['-I', '-S', '-B', '-c', `${lib}\n${script}`], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n');
    expect(lines).toEqual([CONNECTED, 'ConnectionRefusedError', 'ProbeDeadline', 'True']);
  });

  test('the checks count a completed connect or a slow lookup as open, and only a failed connect (or a 403 where S3 is reachable) as denied', () => {
    expect(noConnection({ error: CONNECTED })).toBe(false);
    expect(noConnection({ error: LOOKUP_SLOW })).toBe(false);
    // a probe thread that could not start tried nothing, so it is never a block
    expect(noConnection({ error: 'RuntimeError' })).toBe(false);
    expect(noConnection({ error: 'ConnectionRefusedError' })).toBe(true);
    expect(noConnection({ status: 404 })).toBe(false);
    for (const b of ['microvm', 'nitro', 'agentcore'] as const) {
      expect(denied('dynamodb', { error: 'ProbeDeadline' }, b)).toBe(true);
      expect(denied('dynamodb', { status: 400 }, b)).toBe(false);
      expect(denied('internet', { error: CONNECTED }, b)).toBe(false);
      expect(denied('internet', { error: LOOKUP_SLOW }, b)).toBe(false);
      expect(denied('internet', {}, b)).toBe(false);
      expect(egressFailed('https_name', { error: 'gaierror' }, b)).toBe(true);
      expect(egressFailed('https_name', { outcome: 403 }, b)).toBe(false);
      expect(egressFailed('tcp_public_ip', { outcome: 'connected' }, b)).toBe(false);
      expect(egressFailed('tcp_public_ip', { error: 'timeout' }, b)).toBe(true);
    }
    expect(denied('s3', { status: 403 }, 'agentcore')).toBe(true);
    expect(denied('s3', { status: 500 }, 'agentcore')).toBe(false);
    expect(denied('s3', { error: 'ProbeDeadline' }, 'agentcore')).toBe(false);
    expect(denied('s3', { status: 403 }, 'nitro')).toBe(false);
    expect(denied('s3', { error: 'ProbeDeadline' }, 'microvm')).toBe(true);
    expect(egressFailed('put_presigned', { outcome: 403 }, 'agentcore')).toBe(true);
    expect(egressFailed('put_presigned', { outcome: 500 }, 'agentcore')).toBe(false);
    expect(egressFailed('put_presigned', { outcome: 400 }, 'agentcore')).toBe(false);
    expect(egressFailed('put_presigned', { outcome: 403 }, 'nitro')).toBe(false);
    expect(egressFailed('put_presigned', { error: 'ProbeDeadline' }, 'nitro')).toBe(true);
    expect(controlAnswered({ outcome: 401 })).toBe(true);
    expect(controlAnswered({ error: 'ProbeDeadline' })).toBe(false);
    expect(controlAnswered(undefined)).toBe(false);
  });

  test('a lookup that neither answers nor fails is ProbeLookupSlow, not blocked; a failed lookup is raised', () => {
    const lib = `CONFIG = {}\n${readFileSync(path.join(HOSTILE_DIR, '_lib.py'), 'utf8')}`;
    const script = [
      'LOOKUP_TIMEOUT = 1',
      'real = socket.getaddrinfo',
      'socket.getaddrinfo = lambda *a, **k: time.sleep(5)',
      'try:',
      '    http("GET", "http://slow.example.com/", timeout=1)',
      'except BaseException as e:',
      '    print(type(e).__name__)',
      'def nxdomain(*a, **k):',
      '    raise socket.gaierror(-2, "Name or service not known")',
      'socket.getaddrinfo = nxdomain',
      'try:',
      '    http("GET", "http://gone.example.com/", timeout=1)',
      'except BaseException as e:',
      '    print(type(e).__name__)',
      'def servfail(*a, **k):',
      '    raise socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution")',
      'socket.getaddrinfo = servfail',
      'try:',
      '    http("GET", "http://flaky.example.com/", timeout=1)',
      'except BaseException as e:',
      '    print(type(e).__name__)',
    ].join('\n');
    const lines = execFileSync('python3', ['-I', '-S', '-B', '-c', `${lib}\n${script}`], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n');
    expect(lines).toEqual([LOOKUP_SLOW, 'gaierror', LOOKUP_SLOW]);
  });

  test('a name whose first address is closed and a later one open counts as open, not blocked', () => {
    const lib = `CONFIG = {}\n${readFileSync(path.join(HOSTILE_DIR, '_lib.py'), 'utf8')}`;
    const script = [
      'srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5); port = srv.getsockname()[1]',
      'def serve():',
      '    while True:',
      '        c, _ = srv.accept(); c.recv(4096); c.sendall(b"HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"); c.close()',
      'threading.Thread(target=serve, daemon=True).start()',
      'gone = socket.socket(); gone.bind(("127.0.0.1", 0)); cport = gone.getsockname()[1]; gone.close()',
      'real = socket.getaddrinfo',
      'def two(host, p, *a, **k):',
      '    if host == "two.example.com":',
      '        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", cport)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]',
      '    return real(host, p, *a, **k)',
      'socket.getaddrinfo = two',
      'print(http("GET", "http://two.example.com:%d/" % port, timeout=1)[0])',
      'def none_open(host, p, *a, **k):',
      '    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", cport))] * 2',
      'socket.getaddrinfo = none_open',
      'try:',
      '    http("GET", "http://closed.example.com/", timeout=1)',
      'except BaseException as e:',
      '    print(type(e).__name__)',
    ].join('\n');
    const lines = execFileSync('python3', ['-I', '-S', '-B', '-c', `${lib}\n${script}`], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n');
    expect(lines).toEqual(['200', 'ConnectionRefusedError']);
  });

  test('IPv4 addresses are tried first, and at most four addresses are tried', () => {
    const lib = `CONFIG = {}\n${readFileSync(path.join(HOSTILE_DIR, '_lib.py'), 'utf8')}`;
    const script = [
      'srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5); port = srv.getsockname()[1]',
      'gone = socket.socket(); gone.bind(("127.0.0.1", 0)); cport = gone.getsockname()[1]; gone.close()',
      'closed4 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", cport))',
      'open4 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))',
      'v6 = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", cport, 0, 0))',
      'socket.getaddrinfo = lambda *a, **k: [v6, v6, v6, v6, open4]',
      'print(len(_resolve("http://x.example.com/")), _resolve("http://x.example.com/")[0][3][1] == port)',
      'socket.getaddrinfo = lambda *a, **k: [closed4, closed4, closed4, open4]',
      '_connect(_resolve("http://x.example.com/"), 1); print("connected")',
      'socket.getaddrinfo = lambda *a, **k: [closed4, closed4, closed4, closed4, open4]',
      'try:',
      '    _connect(_resolve("http://x.example.com/"), 1)',
      'except BaseException as e:',
      '    print(type(e).__name__)',
    ].join('\n');
    const lines = execFileSync('python3', ['-I', '-S', '-B', '-c', `${lib}\n${script}`], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n');
    expect(lines).toEqual(['4 True', 'connected', 'ConnectionRefusedError']);
  });

  test('the slot precheck needs every slot the stack creates', () => {
    expect(slotsFree(7, 3)).toBe(true);
    expect(slotsFree(8, 3)).toBe(false);
    expect(slotsFree(9, 3)).toBe(false);
    expect(slotsFree(10, 0)).toBe(true);
  });

  test('the control-byte print passes only cut, under the response limit, and all 0x01', () => {
    const ok = { truncated: true, stdout: '\u0001'.repeat(1000) };
    expect(controlOutputOk(ok)).toBe(true);
    expect(controlOutputOk({ ...ok, truncated: false })).toBe(false);
    expect(controlOutputOk({ ...ok, stdout: `${ok.stdout}x` })).toBe(false);
    expect(controlOutputOk({ ...ok, stdout: '' })).toBe(false);
    expect(controlOutputOk({ truncated: true, stdout: '\u0001'.repeat(Math.ceil(6_500_000 / 6)) })).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ truncated: true, stdout: '\u0001'.repeat(Math.ceil(6_500_000 / 6)) }))).toBeGreaterThan(LAMBDA_RESPONSE_BYTES);
    expect(controlOutputOk(undefined)).toBe(false);
  });

  test('the limits probe reads an input back whole and prints control bytes at the size it is given', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-limits-'));
    const data = Buffer.from([0, 1, 2, 255, 10, 13]);
    writeFileSync(path.join(dir, 'input'), data);
    const input = probeCode('limits', { mode: 'input' }).replaceAll('/work/input', path.join(dir, 'input'));
    expect(lastJsonLine(execFileSync('python3', ['-I', '-S', '-B', '-c', input], { encoding: 'utf8' }))).toEqual({
      sha256: createHash('sha256').update(data).digest('hex'), size: data.length,
    });
    const control = execFileSync('python3', ['-I', '-S', '-B', '-c', probeCode('limits', { mode: 'control', bytes: 4096 })]);
    expect(control.length).toBe(4096);
    expect(control.every((b) => b === 1)).toBe(true);
  });

  test('the probes build the metadata address from parts and print no secret', () => {
    for (const p of [...PROBES, '_lib']) {
      const text = readFileSync(path.join(HOSTILE_DIR, `${p}.py`), 'utf8');
      expect(text).not.toMatch(/169\.254\.169\.254/);
      expect(text).not.toMatch(/print\(.*(creds|secret|token)/i);
    }
  });
});
