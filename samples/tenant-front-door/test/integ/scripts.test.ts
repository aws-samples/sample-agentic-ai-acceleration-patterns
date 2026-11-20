// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The integration test's demo application scripts and its tfd-probe hook
 * (test/integ/app, test/integ/hooks; spec §10 steps 11, 12, 20, 21), run
 * with bash against stub `curl` and `aws` commands (test/hooks/support.ts),
 * and the driver's own shape: syntax, names, step lists, teardown order.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { integNames } from './inputs';
import { SAMPLE_ROOT, ScriptHarness } from '../hooks/support';

const APP = path.join(SAMPLE_ROOT, 'test', 'integ', 'app');
const PROBE_HOOK = path.join(SAMPLE_ROOT, 'test', 'integ', 'hooks', 'probe-hook.sh');
const REGISTRAR = 'https://abcdefghij.execute-api.eu-central-1.amazonaws.com/v1/';
const TENANT = '01KAF5M0000000000000000T01';
const PEER = '01KAF5M0000000000000000T02';
const CELL = '01KAF5M0000000000000000C01';
const CREDS = { Version: 1, AccessKeyId: 'AKIAEXAMPLESTUB00000', SecretAccessKey: 'stub-secret-key-value', SessionToken: 'stub-session-token' };

/**
 * An aws stub that also takes `ssm put-parameter` and `ssm delete-parameter`
 * (recorded, answering 0), on top of the harness's export-credentials and
 * queued get-parameter answers.
 */
const AWS_STUB = `#!/usr/bin/env bash
set -euo pipefail
n=$(( $(cat "$STUB_DIR/aws.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/aws.count"
printf '%s\\n' "$@" > "$STUB_DIR/aws.$n.args"
case "$1 $2" in
  "configure export-credentials") cat "$STUB_DIR/creds.json" ;;
  "ssm put-parameter"|"ssm delete-parameter") ;;
  "ssm get-parameter")
    m=$(( $(cat "$STUB_DIR/ssm.count" 2>/dev/null || echo 0) + 1 ))
    echo "$m" > "$STUB_DIR/ssm.count"
    if [[ -f "$STUB_DIR/ssm.$m.out" ]]; then cat "$STUB_DIR/ssm.$m.out"; exit 0; fi
    cat "$STUB_DIR/ssm.$m.err" >&2; exit 254 ;;
  *) echo "aws stub: unexpected call $*" >&2; exit 2 ;;
esac
`;

let h: ScriptHarness;
beforeEach(() => {
  h = new ScriptHarness().credentials(CREDS);
  fs.writeFileSync(path.join(h.dir, 'bin', 'aws'), AWS_STUB, { mode: 0o755 });
});
afterEach(() => h.cleanup());

const EDGE_PARAM = { value: JSON.stringify({ version: 1, registrarUrl: REGISTRAR }) };
const HOOK_PARAM = { value: JSON.stringify({ version: 1, registrarUrl: REGISTRAR, appDomain: 'app.example.com', addressing: 'single' }) };
const NOT_FOUND = { error: 'An error occurred (ParameterNotFound) when calling the GetParameter operation' };
const env = (over: Record<string, string>) => ({ APPLICATION_ID: 'tfd-r1', AWS_REGION: 'eu-central-1', ...over });
const puts = () => h.awsCalls().filter((c) => c[1] === 'put-parameter').map((c) => ({ name: c[c.indexOf('--name') + 1], value: c[c.indexOf('--value') + 1] }));

describe('the scripts', () => {
  const scripts = [
    ...['cell', 'tenant'].flatMap((d) => ['create.sh', 'update.sh', 'delete.sh'].map((f) => path.join(APP, d, f))),
    path.join(APP, 'plain', 'noop.sh'), path.join(APP, 'shared', 'registrar.sh'), PROBE_HOOK,
  ];
  it('every script the source zip carries is tracked by git, so a clean clone stages the same zip', () => {
    const tracked = spawnSync('git', ['ls-files', '--', 'test/integ/app', 'test/integ/hooks'], { cwd: SAMPLE_ROOT, encoding: 'utf8' });
    expect(tracked.status).toBe(0);
    const files = tracked.stdout.split('\n').filter(Boolean).map((f) => path.join(SAMPLE_ROOT, f));
    for (const file of scripts) expect(files).toContain(file);
  });
  it.each(scripts)('%s runs under set -euo pipefail and never traces', (file) => {
    const source = fs.readFileSync(file, 'utf8');
    if (!file.endsWith('registrar.sh')) expect(source).toMatch(/^set -euo pipefail$/m);
    expect(source).not.toMatch(/set -[a-z]*x/);
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
  });
});

describe('the tenant script', () => {
  it('writes the namespace parameter the cell\'s hosts check reads, and calls no registrar', () => {
    const r = h.run(path.join(APP, 'tenant', 'create.sh'), env({ TENANT_ID: TENANT, CELL_ID: CELL, PARAM_TFD_PROBE: 'off' }));
    expect(r.status).toBe(0);
    expect(puts()).toEqual([{ name: `/application-plane/tenants/${TENANT}/tfd-r1/deployed`, value: CELL }]);
    expect(h.curlCalls()).toEqual([]);
  });

  it('step 11: calls the registrar as its own role, three 403s pass and are recorded', () => {
    h.ssm(EDGE_PARAM).curl({ status: 403 }, { status: 403 }, { status: 403 });
    const r = h.run(path.join(APP, 'tenant', 'update.sh'), env({ TENANT_ID: TENANT, CELL_ID: CELL, PARAM_TFD_PROBE: 'step11', PARAM_TFD_PROBE_PEER: PEER }));
    expect(r.status).toBe(0);
    const calls = h.curlCalls();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${REGISTRAR}tenants/${TENANT}`, `PUT ${REGISTRAR}tenants/${PEER}`, `PUT ${REGISTRAR}tenants/${TENANT}`,
    ]);
    expect(JSON.parse(calls[2].data!)).toEqual({ customDomain: 'dedicated-b.example.com' });
    for (const c of calls) {
      expect(c.args).toContain('aws:amz:eu-central-1:execute-api');
      expect(c.configMode).toBe('600');
      expect(c.config).toContain(`${CREDS.AccessKeyId}:${CREDS.SecretAccessKey}`);
      expect(c.args.join(' ')).not.toContain(CREDS.SecretAccessKey);
    }
    expect(r.output).not.toContain(CREDS.SecretAccessKey);
    expect(puts()[0]).toEqual({
      name: `/application-plane/tenants/${TENANT}/tfd-r1/registrar-probe`,
      value: '{"put-own-route":"403","put-peer-route":"403","put-own-custom-domain":"403"}',
    });
    expect(h.leftovers()).toEqual([]);
  });

  it('step 11: any other answer fails the script, so the update lands in UPDATE_FAILED', () => {
    h.ssm(EDGE_PARAM).curl({ status: 403 }, { status: 200 }, { status: 403 });
    const r = h.run(path.join(APP, 'tenant', 'update.sh'), env({ TENANT_ID: TENANT, PARAM_TFD_PROBE: 'step11', PARAM_TFD_PROBE_PEER: PEER }));
    expect(r.status).toBe(1);
    expect(r.output).toContain('registrar probe put-peer-route: want 403, got 200');
  });

  it('step 13: DeleteTenantRoute and PutTenantRoute for itself', () => {
    h.ssm(EDGE_PARAM).curl({ status: 403 }, { status: 403 });
    const r = h.run(path.join(APP, 'tenant', 'update.sh'), env({ TENANT_ID: TENANT, PARAM_TFD_PROBE: 'step13' }));
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => c.method)).toEqual(['DELETE', 'PUT']);
  });

  it('refuses a peer that is not a tenant id, and an unknown probe', () => {
    expect(h.run(path.join(APP, 'tenant', 'update.sh'), env({ TENANT_ID: TENANT, PARAM_TFD_PROBE: 'step11', PARAM_TFD_PROBE_PEER: 'none' })).status).toBe(1);
    expect(h.run(path.join(APP, 'tenant', 'update.sh'), env({ TENANT_ID: TENANT, PARAM_TFD_PROBE: 'everything' })).status).toBe(1);
    expect(h.curlCalls()).toEqual([]);
  });
});

describe('the cell script', () => {
  const outputs = () => path.join(h.dir, 'outputs.json');
  const DOMAIN = 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-central-1.on.aws';

  it('names the cell API as frontDoorApiDomain', () => {
    h.ssm({ value: DOMAIN });
    const r = h.run(path.join(APP, 'cell', 'create.sh'), env({ CELL_ID: CELL, OUTPUTS_FILE: outputs() }));
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputs(), 'utf8'))).toEqual({ frontDoorApiDomain: DOMAIN });
    expect(h.awsCalls()[0]).toContain('/application-plane/applications/tfd-r1/shared/front-door-cell-api');
  });

  it('step 21: writes no output when FRONT_DOOR_OUTPUT is off', () => {
    const r = h.run(path.join(APP, 'cell', 'update.sh'), env({ CELL_ID: CELL, OUTPUTS_FILE: outputs(), PARAM_FRONT_DOOR_OUTPUT: 'off' }));
    expect(r.status).toBe(0);
    expect(fs.existsSync(outputs())).toBe(false);
  });

  it('refuses a cell API parameter that is not a function URL host', () => {
    h.ssm({ value: 'origin.example.com' });
    expect(h.run(path.join(APP, 'cell', 'create.sh'), env({ CELL_ID: CELL, OUTPUTS_FILE: outputs() })).status).toBe(1);
  });

  it('step 12 in the control plane\'s account: the registrar from the hook parameter, two DeleteCellRoute 403s', () => {
    h.ssm(NOT_FOUND, HOOK_PARAM, { value: DOMAIN }).curl({ status: 403 }, { status: 403 });
    const r = h.run(path.join(APP, 'cell', 'update.sh'), env({
      CELL_ID: CELL, OUTPUTS_FILE: outputs(), PARAM_TFD_CELL_PROBE: 'step12', PARAM_TFD_CELL_PROBE_PEER: '01KAF5M0000000000000000C02',
    }));
    expect(r.status).toBe(0);
    expect(h.curlCalls().map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${REGISTRAR}cells/${CELL}`, `DELETE ${REGISTRAR}cells/01KAF5M0000000000000000C02`,
    ]);
    expect(puts()[0].name).toBe(`/application-plane/cells/${CELL}/registrar-probe`);
  });
});

describe('the tfd-probe hook', () => {
  const hookEnv = (event: string) => env({ EVENT: event, PHASE: 'POST', HOOK_SCOPE: 'GLOBAL', CELL_ID: CELL, TENANT_ID: TENANT });

  it('on DEPLOYMENT_UPDATE expects 409 for DeleteTenantRoute and PutCellRoute', () => {
    h.ssm(HOOK_PARAM, NOT_FOUND, HOOK_PARAM).curl({ status: 409 }, { status: 409 });
    const r = h.run(PROBE_HOOK, hookEnv('DEPLOYMENT_UPDATE'));
    expect(r.status).toBe(0);
    const calls = h.curlCalls();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${REGISTRAR}tenants/${TENANT}`, `PUT ${REGISTRAR}cells/${CELL}`]);
    expect(JSON.parse(calls[1].data!).apiDomain).toMatch(/^[a-z0-9]{32}\.lambda-url\.eu-central-1\.on\.aws$/);
  });

  it('on CELL_UPDATE expects 409 for another origin and 400 for a host outside the form', () => {
    h.ssm(HOOK_PARAM, NOT_FOUND, HOOK_PARAM).curl({ status: 409 }, { status: 400 });
    expect(h.run(PROBE_HOOK, hookEnv('CELL_UPDATE')).status).toBe(0);
    expect(JSON.parse(h.curlCalls()[1].data!)).toEqual({ apiDomain: 'origin.example.com' });
  });

  it('fails the operation on any other answer, naming it', () => {
    h.ssm(HOOK_PARAM, NOT_FOUND, HOOK_PARAM).curl({ status: 200 }, { status: 409 });
    const r = h.run(PROBE_HOOK, hookEnv('DEPLOYMENT_UPDATE'));
    expect(r.status).toBe(1);
    expect(r.output).toContain('delete-tenant-route-while-updating: want 409, got 200');
  });

  it('acts only for an application with a front door, and fails on another read error', () => {
    h.ssm(NOT_FOUND);
    expect(h.run(PROBE_HOOK, hookEnv('CELL_UPDATE')).status).toBe(0);
    expect(h.curlCalls()).toEqual([]);
    h.ssm({ error: 'An error occurred (AccessDeniedException)' });
    expect(h.run(PROBE_HOOK, hookEnv('CELL_UPDATE')).status).toBe(1);
  });

  it('refuses another phase or scope', () => {
    expect(h.run(PROBE_HOOK, { ...hookEnv('CELL_UPDATE'), PHASE: 'PRE' }).status).toBe(1);
    expect(h.curlCalls()).toEqual([]);
  });
});

describe('the driver', () => {
  const DRIVER = path.join(SAMPLE_ROOT, 'scripts', 'integ.sh');
  const parts = ['integ.sh', 'integ/lib.sh', 'integ/deploy.sh', 'integ/steps.sh', 'integ/teardown.sh'].map((f) => path.join(SAMPLE_ROOT, 'scripts', f));
  const plan = (mode: string, runId = 'r1') => spawnSync('bash', [DRIVER, 'plan', mode], { env: { ...process.env, TFD_INTEG_RUN_ID: runId }, encoding: 'utf8' });

  it.each(parts)('%s parses and never traces', (file) => {
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/set -[a-z]*x/);
  });

  it('names every stack, role and policy as test/integ/inputs.ts does', () => {
    const r = plan('single');
    expect(r.status).toBe(0);
    const names = integNames('r1');
    const got = Object.fromEntries(r.stdout.split('\n').filter((l) => /^(stack|role) /.test(l)).map((l) => {
      const [kind, key, value] = l.split(' ');
      return [`${kind}.${key}`, value];
    }));
    for (const [key, value] of Object.entries(names.stacks)) expect(got[`stack.${key}`]).toBe(value);
    for (const [key, value] of Object.entries(names.roles)) expect(got[`role.${key}`]).toBe(value);
    expect(r.stdout).toContain(`policy pairProbe ${names.pairProbePolicy}`);
    expect(r.stdout).toContain(`fleet ${names.fleet}`);
    expect(r.stdout).toContain(`application ${names.applicationId} ${names.plainApplicationId}`);
  });

  it('runs the §10 steps of each mode, step 14 in single mode only, and step 24 last', () => {
    expect(plan('single').stdout).toMatch(/^steps 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 19 20 21 22 23 24$/m);
    expect(plan('host').stdout).toMatch(/^steps 01 02 03 04 11 15 17 18 23 24$/m);
  });

  it('tears down in the §6.2 order', () => {
    const body = fs.readFileSync(path.join(SAMPLE_ROOT, 'scripts', 'integ', 'teardown.sh'), 'utf8');
    const order = [...body.matchAll(/^ {2}try "([^"]+)"/gm)].map((m) => m[1]);
    const at = (label: string) => order.findIndex((o) => o.startsWith(label));
    expect(at('step 2 fixture key')).toBeLessThan(at('(1)'));
    for (const [a, b] of [['(1)', '(2)'], ['(2)', '(3)'], ['(3)', '(4)'], ['(4)', '(5)'], ['(5)', '(6)'], ['(6)', 'control plane records'],
      ['control plane records', 'control plane and the edge'], ['control plane and the edge', 'control plane setup']]) {
      expect(at(a)).toBeGreaterThanOrEqual(0);
      expect(at(a)).toBeLessThan(at(b));
    }
  });

  it('fails fast without its inputs, before any AWS call', () => {
    const r = spawnSync('bash', [DRIVER, 'single'], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('set AWS_REGION');
  });

  it('refuses a run id outside its pattern', () => {
    expect(plan('single', 'Bad_Id').status).toBe(2);
    expect(plan('single', 'awsrun').status).toBe(2);
  });

  it('never puts a token on a command line: tokens reach curl on stdin or in 0600 files', () => {
    const all = parts.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(all).not.toMatch(/-H ["']Authorization/i);
    expect(all).not.toMatch(/--arg [a-z]+ "Bearer/);
    expect(all).not.toMatch(/--password "\$/);
  });
});

describe('the driver\'s teardown of a run that made nothing', () => {
  const RUN = 't0nothing';
  const runDir = path.join(SAMPLE_ROOT, '.integ', RUN);
  /** Answers the reads the teardown and the leftover check make, as for an account where the run left nothing. */
  const AWS_EMPTY = `#!/usr/bin/env bash
args="$*"
echo "$args" >> "$STUB_DIR/aws.log"
case "$1 $2" in
  "sts get-caller-identity") [[ "$args" == *Account* ]] && echo 111111111111 || echo arn:aws:sts::111111111111:assumed-role/Admin/s ;;
  "iam get-role") [[ "$args" == *"--role-name Admin"* ]] && echo arn:aws:iam::111111111111:role/Admin || exit 254 ;;
  "route53 get-hosted-zone") echo integ-placeholder.example.com. ;;
  "route53 list-resource-record-sets") [[ "$args" == *length* ]] && echo 0 || echo null ;;
  "ssm get-parameter") case "$args" in *identity/apiUrl*) echo https://id.example.com/prod/ ;; *identity/*) echo stub ;; *) exit 254 ;; esac ;;
  "ssm get-parameters-by-path") echo 0 ;;
  "cloudformation list-stacks"|"acm list-certificates"|"logs describe-log-groups") echo "" ;;
  "apigateway get-account") echo arn:aws:iam::111111111111:role/apigw-logs ;;
  "cloudformation describe-stacks") [[ "$args" == *TenantIdentity-shared-pool-multi-tenant* ]] && echo ok || exit 254 ;;
  *) exit 254 ;;
esac
`;
  let dir: ScriptHarness;
  beforeEach(() => {
    dir = new ScriptHarness();
    fs.writeFileSync(path.join(dir.dir, 'bin', 'aws'), AWS_EMPTY, { mode: 0o755 });
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.env'), 'EXTERNAL_ID=tfd-integ-x\n');
    fs.writeFileSync(path.join(runDir, 'context.json'), '{}');
  });
  afterEach(() => {
    dir.cleanup();
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  const inputs = {
    AWS_REGION: 'eu-central-1',
    TFD_INTEG_ACCOUNT_B: '222222222222',
    TFD_APP_DOMAIN: 'app.integ-placeholder.example.com',
    TFD_HOSTED_ZONE_ID: 'ZPLACEHOLDER0',
    TFD_DEDICATED_DOMAIN: 'dd.integ-placeholder.example.com',
    HOME: process.env.HOME,
  };

  it('runs every part, skips what is gone, finds no leftover and calls no curl', () => {
    const r = dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), inputs, ['teardown', RUN, 'single']);
    expect(r.output).toContain('teardown: (6) front door, cells, test role, agent ingress: done');
    expect(r.output).toContain('NOT CHECKED: the control plane setup stack');
    expect(r.output).not.toContain('LEFTOVER');
    expect(r.output).not.toContain('unbound variable');
    expect(r.output).toMatch(/result: \d+ passed, 0 failed/);
    expect(r.status).toBe(0);
    expect(dir.curlCalls()).toEqual([]);
  });

  it('a run whose first deploy fails: preflight writes the context, the EXIT trap tears down, the run fails', () => {
    // npx fails every CDK call; smithy is a no-op.
    fs.writeFileSync(path.join(dir.dir, 'bin', 'npx'), '#!/usr/bin/env bash\necho "npx $*" >> "$STUB_DIR/npx.log"\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir.dir, 'bin', 'smithy'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.rmSync(runDir, { recursive: true, force: true });
    const r = dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), { ...inputs, TFD_INTEG_RUN_ID: RUN }, ['single']);
    expect(r.status).toBe(1);
    expect(r.output).toContain(`preflight: run ${RUN}, single mode, eu-central-1, edge account 111111111111, control plane's account 222222222222`);
    expect(r.output).toContain('a phase 1 stack failed');
    expect(r.output).toContain('== 24. remove the fixture, then the ordered teardown');
    expect(r.output).not.toContain('unbound variable');
    const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
    expect(context).toMatchObject({
      runId: RUN,
      edgeAccount: '111111111111',
      controlPlaneAccount: '222222222222',
      region: 'eu-central-1',
      driverPrincipalArn: 'arn:aws:iam::111111111111:role/Admin',
      zoneName: 'integ-placeholder.example.com',
      identity: { userPoolId: 'stub', appClientId: 'stub', region: 'eu-central-1' },
    });
    // ipRequestsPer5Min is a host-mode input: the front door refuses it in single mode (§3.6).
    expect(context.ipRequestsPer5Min).toBeUndefined();
    expect(context.tenantRequestsPer5Min).toBeUndefined();
    const npx = fs.readFileSync(path.join(dir.dir, 'npx.log'), 'utf8');
    expect(npx).toContain(`deploy --exclusively TfdInteg-${RUN}-support`);
    expect(npx).toContain('test/integ.single.ts');
    expect(fs.readFileSync(path.join(runDir, 'times.tsv'), 'utf8')).toMatch(/deploy\tsupport\t\d+\tfailed/);
  });
});
