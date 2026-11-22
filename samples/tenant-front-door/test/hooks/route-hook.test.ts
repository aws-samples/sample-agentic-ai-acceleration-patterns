// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `hooks/route-hook.sh` (spec §3.4 route hook steps 1 to 4, §4.2, §5.2),
 * run with bash against stub `curl`, `aws` and `sleep` (test/hooks/support.ts)
 * in the control plane's hook environment (control-plane R-42).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SAMPLE_ROOT, ScriptHarness } from './support';
import { paramHook, ROUTE_PROPAGATION_WAIT_SECONDS } from '../../src/shared/contracts';

const HOOK = path.join(SAMPLE_ROOT, 'hooks', 'route-hook.sh');
const REGION = 'eu-central-1';
const REGISTRAR = 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/v1/';
const APP = 'demo-app';
const CELL = '01KAF5M0000000000000000C01';
const TENANT = '01KAF5M0000000000000000T01';
const API_DOMAIN = `${'a1'.repeat(16)}.lambda-url.${REGION}.on.aws`;
const CREDS = {
  Version: 1,
  // AWS documentation example values, not real credentials.
  AccessKeyId: 'ASIAIOSFODNN7EXAMPLE',
  SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  SessionToken: 'TESTSESSIONTOKENEXAMPLE=',
  Expiration: '2026-11-20T12:00:00Z',
};

function parameter(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, registrarUrl: REGISTRAR, appDomain: 'app.example.com', addressing: 'single', ...over });
}

function hookEnv(phase: string, event: string, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const isCell = event.startsWith('CELL_');
  return {
    EVENT: event,
    PHASE: phase,
    HOOK_ID: phase === 'POST' ? 'front-door-post' : 'front-door-pre',
    HOOK_SCOPE: 'GLOBAL',
    APPLICATION_ID: APP,
    CELL_ID: CELL,
    CELL_ACCOUNT_ID: '111111111111',
    TENANT_ID: isCell ? undefined : TENANT,
    TENANT_NAME: isCell ? undefined : 'Tenant "$(rm -f x)" name',
    EXECUTION_ID: 'exec-1',
    ATTEMPT: '1',
    OPERATOR_ID: 'operator-sub',
    HOOK_SCRIPT: 'samples/tenant-front-door/hooks/route-hook.sh',
    AWS_REGION: REGION,
    SCRIPT_OUTPUTS: phase === 'POST' ? (isCell ? JSON.stringify({ frontDoorApiDomain: API_DOMAIN, other: 'x' }) : '{}') : undefined,
    ...over,
  };
}

let h: ScriptHarness;
beforeEach(() => {
  h = new ScriptHarness().credentials(CREDS);
});
afterEach(() => h.cleanup());

function expectNoSecrets(output: string): void {
  for (const secret of [CREDS.SecretAccessKey, CREDS.SessionToken, CREDS.AccessKeyId]) {
    expect(output).not.toContain(secret);
  }
}

describe('the script', () => {
  it('runs under set -euo pipefail and never traces (scripts/CONVENTIONS.md)', () => {
    const source = fs.readFileSync(HOOK, 'utf8');
    expect(source).toMatch(/^set -euo pipefail$/m);
    expect(source).not.toMatch(/set -[a-z]*x/);
    const code = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(code).not.toMatch(/\beval\b/);
    expect(() => fs.accessSync(HOOK, fs.constants.X_OK)).not.toThrow();
  });
});

describe('registration checks (control-plane scripts/CONVENTIONS.md)', () => {
  it.each([
    ['POST', 'CELL_DELETE'],
    ['PRE', 'CELL_CREATE'],
    ['PRE', 'DEPLOYMENT_UPDATE'],
    ['POST', 'TENANT_CREATE'],
    ['PRE', 'ACCOUNT_DELETE'],
  ])('fails on %s %s before any call', (phase, event) => {
    const r = h.run(HOOK, hookEnv(phase, event));
    expect(r.status).toBe(1);
    expect(r.output).toContain(`got ${phase} ${event}`);
    expect(h.awsCalls()).toEqual([]);
    expect(h.curlCalls()).toEqual([]);
  });

  it('fails as an application hook', () => {
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE', { HOOK_SCOPE: 'APPLICATION' }));
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/global hook, got scope APPLICATION/);
    expect(h.awsCalls()).toEqual([]);
  });

  it.each([
    ['APPLICATION_ID', 'Demo_App'],
    ['APPLICATION_ID', '../x'],
    ['AWS_REGION', 'eu-central-1; x'],
  ])('fails on %s %j', (key, value) => {
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE', { [key]: value }));
    expect(r.status).toBe(1);
    expect(h.awsCalls()).toEqual([]);
  });

  it.each(['EVENT', 'PHASE', 'HOOK_ID', 'HOOK_SCOPE', 'APPLICATION_ID', 'AWS_REGION'])('names a missing %s', (key) => {
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE', { [key]: undefined }));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(`${key} env var is required`);
  });
});

describe('step 1: the front door hook parameter', () => {
  it('reads the application\'s parameter by name', () => {
    h.ssm({ error: 'An error occurred (ParameterNotFound) when calling the GetParameter operation:' });
    h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(h.awsCalls()[0]).toEqual(['ssm', 'get-parameter', '--name', paramHook(APP), '--query', 'Parameter.Value', '--output', 'text']);
  });

  it.each([
    ['POST', 'CELL_CREATE'],
    ['POST', 'DEPLOYMENT_UPDATE'],
    ['PRE', 'CELL_DELETE'],
    ['PRE', 'DEPLOYMENT_DELETE'],
  ])('exits 0 with no call on ParameterNotFound, %s %s (ADR-0014)', (phase, event) => {
    h.ssm({ error: 'An error occurred (ParameterNotFound) when calling the GetParameter operation:' });
    const r = h.run(HOOK, hookEnv(phase, event));
    expect(r.status).toBe(0);
    expect(r.output).toContain('has no front door');
    expect(h.curlCalls()).toEqual([]);
    expect(h.awsCalls()).toHaveLength(1);
  });

  it('fails at once on any other read error, AccessDenied included', () => {
    h.ssm({ error: 'An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized' });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/reading .*front-door-hook failed: .*AccessDeniedException/);
    expect(h.awsCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([]);
  });

  it('retries a throttled read, five attempts with jittered backoff over about a minute', () => {
    const throttled = { error: 'An error occurred (ThrottlingException) when calling the GetParameter operation: Rate exceeded' };
    h.ssm(throttled, { error: 'An error occurred (TooManyRequestsException) ...' }, throttled, throttled, { value: parameter() });
    h.curl({ status: 200, body: { cellId: CELL, apiDomain: API_DOMAIN } });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(0);
    const sleeps = h.sleeps();
    expect(sleeps).toHaveLength(5);
    [[2, 4], [4, 8], [8, 16], [16, 32]].forEach(([lo, hi], i) => {
      expect(sleeps[i]).toBeGreaterThanOrEqual(lo);
      expect(sleeps[i]).toBeLessThanOrEqual(hi);
    });
    expect(sleeps[4]).toBe(ROUTE_PROPAGATION_WAIT_SECONDS);
  });

  it('fails when the read is still throttled after five attempts', () => {
    const throttled = { error: 'An error occurred (ThrottlingException) when calling the GetParameter operation: Rate exceeded' };
    h.ssm(throttled, throttled, throttled, throttled, throttled);
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(1);
    expect(h.awsCalls()).toHaveLength(5);
    expect(h.sleeps()).toHaveLength(4);
    expect(h.curlCalls()).toEqual([]);
  });

  it.each([
    ['not JSON', 'https://abcde12345.execute-api.eu-central-1.amazonaws.com/v1/'],
    ['another version', parameter({ version: 2 })],
    ['no registrarUrl', JSON.stringify({ version: 1, appDomain: 'app.example.com', addressing: 'single' })],
    ['an unknown addressing', parameter({ addressing: 'path' })],
    ['a registrar outside API Gateway', parameter({ registrarUrl: 'https://registrar.example.com/v1/' })],
    ['a registrar URL without its trailing slash', parameter({ registrarUrl: REGISTRAR.slice(0, -1) })],
    ['a registrar in another Region', parameter({ registrarUrl: 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1/' })],
    ['an upper-case appDomain', parameter({ appDomain: 'App.example.com' })],
    ['an appDomain with a path', parameter({ appDomain: 'app.example.com/x' })],
  ])('fails on a parameter with %s', (_name, value) => {
    h.ssm({ value });
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE'));
    expect(r.status).toBe(1);
    expect(h.curlCalls()).toEqual([]);
  });

  it('accepts a registrar URL with a longer path, so a broken path reaches API Gateway (spec §10 step 22)', () => {
    h.ssm({ value: parameter({ registrarUrl: `${REGISTRAR}nowhere/` }) });
    h.curl({ status: 403, body: { message: 'Forbidden' } });
    const r = h.run(HOOK, hookEnv('PRE', 'DEPLOYMENT_DELETE'));
    expect(r.status).toBe(1);
    expect(h.curlCalls()[0].url).toBe(`${REGISTRAR}nowhere/tenants/${TENANT}`);
  });
});

describe('step 2: ids and outputs', () => {
  beforeEach(() => {
    h.ssm({ value: parameter() });
  });

  it.each([
    ['CELL_ID', 'POST', 'CELL_CREATE', 'cell-1'],
    ['CELL_ID', 'PRE', 'CELL_DELETE', '01kaf5m0000000000000000c01'],
    ['TENANT_ID', 'POST', 'DEPLOYMENT_CREATE', `${TENANT}/../cells`],
    ['TENANT_ID', 'PRE', 'DEPLOYMENT_DELETE', '01KAF5M0000000000000000T0I'],
  ])('fails on a %s that is not a control-plane id (%s %s)', (key, phase, event, value) => {
    const r = h.run(HOOK, hookEnv(phase, event, { [key]: value }));
    expect(r.status).toBe(1);
    expect(r.output).toContain(`${key} is not a control-plane id`);
    expect(h.curlCalls()).toEqual([]);
  });

  it('names a missing TENANT_ID on a deployment event', () => {
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE', { TENANT_ID: undefined }));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('TENANT_ID env var is required');
  });

  it.each([
    ['no SCRIPT_OUTPUTS', undefined, /SCRIPT_OUTPUTS env var is required/],
    ['an empty value', '', /not a JSON object of strings/],
    ['an array', '["frontDoorApiDomain"]', /not a JSON object of strings/],
    ['a value that is not a string', JSON.stringify({ frontDoorApiDomain: { host: API_DOMAIN } }), /not a JSON object of strings/],
    ['malformed JSON', '{"frontDoorApiDomain":', /not a JSON object of strings/],
    ['a repeated key, last one valid', `{"frontDoorApiDomain":"evil.example.com","frontDoorApiDomain":"${API_DOMAIN}"}`, /repeated key/],
    ['a repeated key, first one valid', `{"frontDoorApiDomain":"${API_DOMAIN}","x":"1","frontDoorApiDomain":"evil.example.com"}`, /repeated key/],
    ['no frontDoorApiDomain', '{}', /wrote no frontDoorApiDomain/],
    ['an empty frontDoorApiDomain', '{"frontDoorApiDomain":""}', /wrote no frontDoorApiDomain/],
    ['a host outside the function URL form', JSON.stringify({ frontDoorApiDomain: 'api.example.com' }), /not a Lambda function URL host/],
    ['a function URL in another Region', JSON.stringify({ frontDoorApiDomain: `${'a1'.repeat(16)}.lambda-url.us-east-1.on.aws` }), /not a Lambda function URL host/],
    ['shell metacharacters', JSON.stringify({ frontDoorApiDomain: `$(touch pwned).lambda-url.${REGION}.on.aws` }), /not a Lambda function URL host/],
    ['a trailing newline', JSON.stringify({ frontDoorApiDomain: `${API_DOMAIN}\n` }), /not a Lambda function URL host/],
  ])('fails a cell POST on %s (control-plane R-43, T-29)', (_name, outputs, error) => {
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE', { SCRIPT_OUTPUTS: outputs }));
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(error);
    expect(r.output).not.toContain('evil.example.com');
    expect(h.curlCalls()).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, 'pwned'))).toBe(false);
  });

  it('does not read SCRIPT_OUTPUTS on a deployment POST', () => {
    h.curl({ status: 200, body: { tenantId: TENANT, dt: 1 } });
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE', { SCRIPT_OUTPUTS: 'not json' }));
    expect(r.status).toBe(0);
  });
});

describe('step 3: the signed call', () => {
  beforeEach(() => {
    h.ssm({ value: parameter() });
  });

  it('puts the cell route with the API domain, signed for execute-api in the Region, then waits the bound (§4.2)', () => {
    h.curl({ status: 200, body: { cellId: CELL, apiDomain: API_DOMAIN } });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(0);
    const [call] = h.curlCalls();
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${REGISTRAR}cells/${CELL}`);
    expect(JSON.parse(call.data!)).toEqual({ apiDomain: API_DOMAIN });
    expect(call.args).toEqual(expect.arrayContaining(['--aws-sigv4', `aws:amz:${REGION}:execute-api`, 'Content-Type: application/json']));
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
    expect(r.output).toContain(`PutCellRoute ${CELL}: HTTP 200`);
    expect(r.output).not.toContain(API_DOMAIN);
  });

  it('passes the credentials in a mode-600 curl config and never on the command line or in the output (M-12, T-30)', () => {
    h.curl({ status: 200, body: {} });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_UPDATE'));
    expect(r.status).toBe(0);
    const [call] = h.curlCalls();
    expect(call.configMode).toBe('600');
    expect(call.dataMode).toBe('600');
    expect(call.config).toBe(
      `user = "${CREDS.AccessKeyId}:${CREDS.SecretAccessKey}"\nheader = "x-amz-security-token: ${CREDS.SessionToken}"\n`,
    );
    expect(call.args.join(' ')).not.toContain(CREDS.SecretAccessKey);
    expect(call.args.join(' ')).not.toContain(CREDS.SessionToken);
    expect(call.args).toContain('-K');
    expectNoSecrets(r.output);
    expect(h.awsCalls()[1]).toEqual(['configure', 'export-credentials', '--format', 'process']);
    expect(h.leftovers()).toEqual([]);
  });

  it('omits the token header for long-term credentials', () => {
    h.credentials({ ...CREDS, SessionToken: undefined });
    h.curl({ status: 200, body: {} });
    expect(h.run(HOOK, hookEnv('PRE', 'CELL_DELETE')).status).toBe(0);
    expect(h.curlCalls()[0].config).toBe(`user = "${CREDS.AccessKeyId}:${CREDS.SecretAccessKey}"\n`);
  });

  it.each([
    ['a quote in the secret', { SecretAccessKey: 'abc"\nheader = "x: y' }],
    ['no access key', { AccessKeyId: undefined }],
    ['a newline in the token', { SessionToken: 'abc\nurl = "https://evil.example.com"' }],
  ])('refuses credentials with %s and calls nothing', (_name, patch) => {
    h.credentials({ ...CREDS, ...patch });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(1);
    expect(r.output).toContain('not in the expected form');
    expect(h.curlCalls()).toEqual([]);
  });

  it('deletes the cell route with no body', () => {
    h.curl({ status: 200, body: {} });
    const r = h.run(HOOK, hookEnv('PRE', 'CELL_DELETE'));
    expect(r.status).toBe(0);
    const [call] = h.curlCalls();
    expect([call.method, call.url, call.data]).toEqual(['DELETE', `${REGISTRAR}cells/${CELL}`, undefined]);
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
  });

  it('puts the tenant route with an empty body: no display name, no customDomain (§3.4 step 2, §5.2)', () => {
    h.curl({ status: 200, body: { tenantId: TENANT, dt: 1763625600000 } });
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE'));
    expect(r.status).toBe(0);
    const [call] = h.curlCalls();
    expect([call.method, call.url, call.data]).toEqual(['PUT', `${REGISTRAR}tenants/${TENANT}`, '{}']);
    expect(r.output).not.toContain('Tenant "');
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
  });

  it('deletes the tenant route and waits the bound in single mode', () => {
    h.curl({ status: 200, body: {} });
    const r = h.run(HOOK, hookEnv('PRE', 'DEPLOYMENT_DELETE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${REGISTRAR}tenants/${TENANT}`]);
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
  });
});

describe('step 4: the answer', () => {
  beforeEach(() => {
    h.ssm({ value: parameter() });
  });

  it('succeeds on 202, a tenant whose dedicated domain is pending', () => {
    h.curl({ status: 202, body: { tenantId: TENANT, dt: 1, stage: 'certificate' } });
    expect(h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_UPDATE')).status).toBe(0);
  });

  it.each([503, 429, 500, 502, 'fail' as const])('retries %s, five attempts with jittered backoff over about two minutes', (first) => {
    const retry = first === 'fail' ? 'fail' : { status: first, body: { message: 'busy' } };
    h.curl(retry, retry, { status: 200, body: {} });
    const r = h.run(HOOK, hookEnv('PRE', 'CELL_DELETE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls()).toHaveLength(3);
    const sleeps = h.sleeps();
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(4);
    expect(sleeps[0]).toBeLessThanOrEqual(8);
    expect(sleeps[1]).toBeGreaterThanOrEqual(8);
    expect(sleeps[1]).toBeLessThanOrEqual(16);
    expect(r.output).toMatch(/attempt 1 of 5\)?, retrying/);
  });

  it('fails after five attempts that all answer 503, with the status and body', () => {
    const busy = { status: 503, body: { message: 'route table busy' } };
    h.curl(busy, busy, busy, busy, busy);
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE'));
    expect(r.status).toBe(1);
    expect(h.curlCalls()).toHaveLength(5);
    const sleeps = h.sleeps();
    expect(sleeps).toHaveLength(4);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120);
    expect(r.output).toContain('PutTenantRoute 01KAF5M0000000000000000T01: HTTP 503: {"message":"route table busy"}');
  });

  it.each([400, 403, 404, 409, 507])('fails at once on %s, printing the status and body', (status) => {
    h.curl({ status, body: { message: 'refused', reason: 'x' } });
    const r = h.run(HOOK, hookEnv('POST', 'CELL_CREATE'));
    expect(r.status).toBe(1);
    expect(h.curlCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([]);
    expect(r.output).toContain(`HTTP ${status}: {"message":"refused","reason":"x"}`);
    expectNoSecrets(r.output);
    expect(h.leftovers()).toEqual([]);
  });
});

describe('host mode: polling the tenant\'s /config.json (§4.2)', () => {
  const DT = 1763625600123;
  const configUrl = `https://${TENANT.toLowerCase()}.app.example.com/config.json`;

  beforeEach(() => {
    h.ssm({ value: parameter({ addressing: 'host' }) });
  });

  it('returns on the first 200 whose rev is the registrar\'s dt, not the old entry\'s', () => {
    h.curl(
      { status: 200, body: { tenantId: TENANT, dt: DT } },
      { status: 404, body: '<html>' },
      { status: 200, body: { tenantId: TENANT, rev: DT - 1000 } },
      { status: 200, body: { tenantId: TENANT, rev: DT } },
    );
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE'));
    expect(r.status).toBe(0);
    const calls = h.curlCalls();
    expect(calls.map((c) => c.url)).toEqual([`${REGISTRAR}tenants/${TENANT}`, configUrl, configUrl, configUrl]);
    expect(calls.slice(1).every((c) => c.config === undefined && !c.args.includes('--aws-sigv4'))).toBe(true);
    expect(h.sleeps()).toEqual([3, 3]);
    expect(r.output).toContain('serves the route at the edge');
  });

  it('warns and exits 0 when the route is not seen within the bound', () => {
    h.curl({ status: 200, body: { tenantId: TENANT, dt: DT } });
    for (let i = 0; i < 20; i++) h.curl({ status: 200, body: { rev: DT - 1 } });
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_UPDATE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls()).toHaveLength(1 + ROUTE_PROPAGATION_WAIT_SECONDS / 3);
    expect(r.output).toMatch(/warning: .* did not show the change within 45 s; the write succeeded/);
  });

  it('stops at the 45 s deadline when the polls run slow, before the poll count bound', () => {
    h.curl({ status: 200, body: { tenantId: TENANT, dt: DT } });
    for (let i = 0; i < 20; i++) h.curl({ status: 200, body: { rev: DT - 1 } });
    // Each 3 s sleep moves the hook's clock 15 s: the deadline falls after three polls, not fifteen.
    const r = h.fakeClock(5).run(HOOK, hookEnv('POST', 'DEPLOYMENT_UPDATE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls()).toHaveLength(1 + 3);
    expect(h.sleeps()).toEqual([3, 3, 3]);
    expect(r.output).toMatch(/warning: .* did not show the change within 45 s; the write succeeded/);
  });

  it('waits the full bound when the answer has no dt', () => {
    h.curl({ status: 200, body: { tenantId: TENANT } });
    const r = h.run(HOOK, hookEnv('POST', 'DEPLOYMENT_CREATE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
  });

  it('returns on the first 404 after a tenant route delete', () => {
    h.curl({ status: 200, body: {} }, { status: 200, body: { rev: DT } }, 'fail', { status: 404, body: '' });
    const r = h.run(HOOK, hookEnv('PRE', 'DEPLOYMENT_DELETE'));
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => c.url)).toEqual([`${REGISTRAR}tenants/${TENANT}`, configUrl, configUrl, configUrl]);
    expect(r.output).toContain('answers 404 at the edge');
  });

  it('waits the full bound for a cell route, which cannot be observed from outside', () => {
    h.curl({ status: 200, body: {} });
    expect(h.run(HOOK, hookEnv('POST', 'CELL_CREATE')).status).toBe(0);
    expect(h.curlCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([ROUTE_PROPAGATION_WAIT_SECONDS]);
  });
});
