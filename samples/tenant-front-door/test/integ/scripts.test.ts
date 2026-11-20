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
import * as os from 'node:os';
import * as path from 'node:path';
import { integNames } from './inputs';
import { SAMPLE_ROOT, ScriptHarness } from '../hooks/support';

const APP = path.join(SAMPLE_ROOT, 'test', 'integ', 'app');
const PROBE_HOOK = path.join(SAMPLE_ROOT, 'test', 'integ', 'hooks', 'probe-hook.sh');
const REGISTRAR = 'https://abcdefghij.execute-api.eu-central-1.amazonaws.com/v1/';
const TENANT = '01KAF5M0000000000000000T01';
const PEER = '01KAF5M0000000000000000T02';
const CELL = '01KAF5M0000000000000000C01';
// AWS documentation example values, not real credentials.
const CREDS = { Version: 1, AccessKeyId: 'ASIAIOSFODNN7EXAMPLE', SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', SessionToken: 'TESTSESSIONTOKENEXAMPLE=' };

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
    const order = [...body.matchAll(/^ {2}try(?:_cp)? "([^"]+)"/gm)].map((m) => m[1]);
    const at = (label: string) => order.findIndex((o) => o.startsWith(label));
    expect(at('step 2 fixture key')).toBeLessThan(at('(1)'));
    for (const [a, b] of [['(1)', '(2)'], ['(2)', '(3)'], ['(3)', '(4)'], ['(4)', '(5)'], ['(5)', '(6)'], ['(6)', 'control plane records'],
      ['control plane records', 'control plane and the edge'], ['control plane and the edge', 'leftovers in the control plane'],
      ['leftovers in the control plane', 'control plane setup']]) {
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

describe('the driver\'s teardown', () => {
  const RUN = 't0nothing';
  const runDir = path.join(SAMPLE_ROOT, '.integ', RUN);
  /**
   * An aws stub for the driver. `describe` sets what DescribeStacks answers
   * for the run's stacks: `missing`, CloudFormation's "does not exist", or
   * `error`, any other error. `assume` sets whether the driver can assume a
   * role. `apigwRoleGone` makes the role API Gateway's account setting
   * names answer NoSuchEntity, as after it was deleted. Every other read
   * answers as for an account where the run left nothing, with each
   * service's own not-found error. Once `$STUB_DIR/creds-gone` exists,
   * every call fails as with no credentials.
   */
  const awsStub = (opts: { describe: 'missing' | 'error'; assume: boolean; blind?: boolean; apigwRoleGone?: boolean }) => `#!/usr/bin/env bash
args="$*"
echo "$args" >> "$STUB_DIR/aws.log"
if [[ -f "$STUB_DIR/creds-gone" ]]; then echo 'Unable to locate credentials. You can configure credentials by running "aws configure".' >&2; exit 253; fi
fail() { echo "An error occurred ($1) when calling the $2 operation: $3" >&2; exit 254; }
case "$1 $2" in
  "sts get-caller-identity") [[ "$args" == *Account* ]] && echo 111111111111 || echo arn:aws:sts::111111111111:assumed-role/Admin/s; exit 0 ;;
  "sts assume-role") ${opts.assume ? 'echo \'{"AccessKeyId":"ASIAIOSFODNN7EXAMPLE","SecretAccessKey":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","SessionToken":"TESTSESSIONTOKENEXAMPLE="}\'; exit 0' : 'fail AccessDenied AssumeRole "not authorized to perform sts:AssumeRole"'} ;;
esac
${opts.blind ? 'fail AccessDenied Any "not authorized"' : ''}
case "$1 $2" in
  "iam get-role") [[ "$args" == *"--role-name Admin"* ${opts.apigwRoleGone ? '' : '|| "$args" == *"--role-name apigw-logs"* '}]] && echo arn:aws:iam::111111111111:role/Admin || fail NoSuchEntity GetRole "The role cannot be found." ;;
  "iam get-policy") fail NoSuchEntity GetPolicy "Policy was not found." ;;
  "route53 get-hosted-zone") echo integ-placeholder.example.com. ;;
  "route53 list-resource-record-sets") [[ "$args" == *length* ]] && echo 0 || echo null ;;
  "ssm get-parameter") case "$args" in *identity/apiUrl*) echo https://id.example.com/prod/ ;; *identity/*) echo stub ;; *) fail ParameterNotFound GetParameter "" ;; esac ;;
  "ssm delete-parameter") fail ParameterNotFound DeleteParameter "" ;;
  "ssm get-parameters-by-path") echo 0 ;;
  "cloudformation list-stacks"|"acm list-certificates"|"logs describe-log-groups") echo "" ;;
  "apigateway get-account") echo arn:aws:iam::111111111111:role/apigw-logs ;;
  "cloudformation describe-stacks")
    [[ "$args" == *TenantIdentity-shared-pool-multi-tenant* ]] && { echo ok; exit 0; }
    ${opts.describe === 'missing' ? 'fail ValidationError DescribeStacks "Stack with id stub does not exist"' : 'fail Throttling DescribeStacks "Rate exceeded"'} ;;
  *) exit 254 ;;
esac
`;
  // npx fails every call and logs it; with `deploy` in its arguments it can also take the credentials away.
  // The SPA build answers 0, so the driver's preflight passes on a tree with no build/spa.
  const npxStub = (dropCredentials: boolean) => `#!/usr/bin/env bash
[[ "$*" == "projen spa:build" ]] && exit 0
echo "npx $*" >> "$STUB_DIR/npx.log"
${dropCredentials ? '[[ "$*" == *" deploy "* ]] && touch "$STUB_DIR/creds-gone"' : ''}
exit 1
`;
  let dir: ScriptHarness;
  const stub = (aws: string, dropCredentials = false) => {
    fs.writeFileSync(path.join(dir.dir, 'bin', 'aws'), aws, { mode: 0o755 });
    fs.writeFileSync(path.join(dir.dir, 'bin', 'npx'), npxStub(dropCredentials), { mode: 0o755 });
    fs.writeFileSync(path.join(dir.dir, 'bin', 'smithy'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  };
  const npxCalls = () => (fs.existsSync(path.join(dir.dir, 'npx.log')) ? fs.readFileSync(path.join(dir.dir, 'npx.log'), 'utf8') : '');
  beforeEach(() => {
    dir = new ScriptHarness();
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.env'), '');
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
  const teardown = () => dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), inputs, ['teardown', RUN, 'single']);

  it('of a run that made nothing: every part skipped on "does not exist", no leftover, no CDK or curl call', () => {
    stub(awsStub({ describe: 'missing', assume: true }));
    const r = teardown();
    expect(r.output).toContain('teardown: (6) front door, cells, test role, agent ingress: skipped');
    expect(r.output).toContain('teardown: control plane and the edge account\'s role pair: skipped');
    expect(r.output).toContain('teardown: control plane setup and support stacks: skipped');
    expect(r.output).not.toContain('FAILED');
    expect(r.output).not.toContain('LEFTOVER');
    expect(r.output).not.toContain('NOT READ');
    expect(r.output).not.toContain('unbound variable');
    expect(r.output).toContain('PASS teardown parts');
    expect(r.output).toMatch(/result: \d+ passed, 0 failed/);
    expect(r.status).toBe(0);
    expect(dir.curlCalls()).toEqual([]);
    expect(npxCalls()).toBe('');
  });

  it('when AWS answers with errors: every part that cannot tell is FAILED, the setup stacks are kept, the leftover check fails', () => {
    stub(awsStub({ describe: 'error', assume: false, blind: true }));
    const r = teardown();
    expect(r.output).toContain('teardown: (6) front door, cells, test role, agent ingress: FAILED');
    expect(r.output).toContain('teardown: control plane and the edge account\'s role pair: FAILED');
    expect(r.output).toContain('teardown: leftovers in the control plane\'s account: FAILED');
    expect(r.output).toContain('teardown: leftovers in the edge account: FAILED');
    expect(r.output).toContain('teardown: control plane setup and support stacks: FAILED');
    expect(r.output).toContain(`kept TfdInteg-${RUN}-cp-setup and TfdInteg-${RUN}-support`);
    expect(r.output).toContain(`scripts/integ.sh teardown ${RUN} single`);
    expect(r.output).toContain('NOT READ the stacks in eu-central-1');
    expect(r.output).toContain('NOT READ the control plane\'s account');
    expect(r.output).toContain('FAIL teardown parts');
    expect(r.output).not.toMatch(/: done$/m);
    expect(r.output).not.toContain('PASS teardown parts');
    expect(r.status).toBe(2);
    expect(npxCalls()).toBe('');
  });

  it('with no credentials: stops at once and names the command that resumes the teardown', () => {
    stub(awsStub({ describe: 'missing', assume: true }));
    fs.writeFileSync(path.join(dir.dir, 'creds-gone'), '');
    const r = teardown();
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(`no working AWS credentials (sts get-caller-identity failed); refresh them, then resume with: scripts/integ.sh teardown ${RUN} single`);
    expect(r.output).not.toContain('teardown: (1)');
  });

  it('a run whose first deploy fails: preflight writes the context, the EXIT trap tears down, the run fails', () => {
    stub(awsStub({ describe: 'error', assume: true }));
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
    const npx = npxCalls();
    expect(npx).toContain(`deploy --exclusively TfdInteg-${RUN}-support`);
    expect(npx).toContain('test/integ.single.ts');
    expect(fs.readFileSync(path.join(runDir, 'times.tsv'), 'utf8')).toMatch(/deploy\tsupport\t\d+\tfailed/);
    // Preflight read the control plane's account through its CDK lookup role, for an existing control plane.
    const aws = fs.readFileSync(path.join(dir.dir, 'aws.log'), 'utf8');
    expect(aws).toContain('cdk-hnb659fds-lookup-role-222222222222-eu-central-1');
    expect(aws).toContain('/control-plane/tenant-api-url');
  });

  it('a run whose credentials vanish mid-deploy: the teardown runs no part and names the command that resumes it', () => {
    stub(awsStub({ describe: 'missing', assume: true }), true);
    fs.rmSync(runDir, { recursive: true, force: true });
    const r = dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), { ...inputs, TFD_INTEG_RUN_ID: RUN }, ['single']);
    expect(r.status).toBe(1);
    expect(r.output).toContain('a phase 1 stack failed');
    expect(r.output).toContain('FAIL teardown not started: the driver\'s credentials are gone');
    expect(r.output).toContain(`resume with: scripts/integ.sh teardown ${RUN} single`);
    expect(r.output).not.toContain('teardown: (1)');
    expect(r.output).not.toContain('PASS teardown parts');
  });

  it('refuses to start when API Gateway\'s CloudWatch Logs role was deleted, before any deploy', () => {
    stub(awsStub({ describe: 'missing', assume: true, apigwRoleGone: true }));
    fs.rmSync(runDir, { recursive: true, force: true });
    const r = dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), { ...inputs, TFD_INTEG_RUN_ID: RUN }, ['single']);
    expect(r.status).toBe(1);
    expect(r.output).toContain('API Gateway\'s CloudWatch Logs role in eu-central-1 no longer exists; set one (test/integ/api-gateway-account.app.ts)');
    expect(fs.readFileSync(path.join(dir.dir, 'aws.log'), 'utf8')).toContain('iam get-role --role-name apigw-logs');
    expect(npxCalls()).not.toContain('deploy');
  });

  it('refuses to start when the control plane\'s account already holds a control plane', () => {
    const aws = awsStub({ describe: 'missing', assume: true })
      .replace('*identity/*) echo stub ;;', '*identity/*) echo stub ;; *control-plane/tenant-api-url*) echo https://cp.example.com/ ;;');
    stub(aws);
    fs.rmSync(runDir, { recursive: true, force: true });
    const r = dir.run(path.join(SAMPLE_ROOT, 'scripts', 'integ.sh'), { ...inputs, TFD_INTEG_RUN_ID: RUN }, ['single']);
    expect(r.status).toBe(1);
    expect(r.output).toContain('the control plane\'s account already holds a control plane in eu-central-1');
    expect(npxCalls()).not.toContain('deploy');
  });
});

describe('the driver\'s helpers (scripts/integ/lib.sh)', () => {
  const LIB = path.join(SAMPLE_ROOT, 'scripts', 'integ', 'lib.sh');
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfd-lib-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  /** Runs SCRIPT after sourcing lib.sh under the driver's own `set -euo pipefail`, with TMP, BODY and HEAD in a fresh directory; stdout and stderr apart. */
  const lib = (script: string) => spawnSync('bash', ['-c', `set -euo pipefail; TMP="$1"; BODY="$TMP/body"; HEAD="$TMP/head"; : >"$BODY"; source "$2"\n${script}`, '_', tmp, LIB],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });

  // A stub IssueToken that numbers its tokens and fails once $TMP/fail exists; a stub curl that answers 200.
  const STUBS = `TENANT_A=T1; TI_USER_A=u1; IDENTITY_API=https://id.example.com/
ti_token() { echo x >>"$TMP/issued"; [[ -f "$TMP/fail" ]] && { TI_TOKEN_ERR="HTTP 500"; return 1; }; printf -v "$4" 'tok-%s' "$(wc -l <"$TMP/issued" | tr -d ' ')"; }
curl() { echo 200; }`;

  it('token_for: a token issued inside $(edge ...) is kept in a 0600 file and reused by the caller', () => {
    const r = lib(`${STUBS}
st="$(edge GET h.example.com /api/whoami A_TOKEN)"; echo "edge:$st"
token_for a A_TOKEN; echo "parent:$A_TOKEN"
st="$(edge GET h.example.com /api/whoami A_TOKEN)"
echo "issued:$(wc -l <"$TMP/issued" | tr -d ' ')"`);
    expect(r.stdout).toContain('edge:200');
    expect(r.stdout).toContain('parent:tok-1');
    expect(r.stdout).toContain('issued:1');
    expect((fs.statSync(path.join(tmp, 'token-a')).mode % 0o1000).toString(8)).toBe('600');
  });

  it('token_for: an IssueToken failure is a failed check, with a note naming the cause', () => {
    const r = lib(`${STUBS}
printf '%s\\n%s\\n' 0 tok-old >"$TMP/token-a"; touch "$TMP/fail"
st="$(edge GET h.example.com /api/whoami A_TOKEN)"; echo "edge:$st"
token_for a A_TOKEN; echo "rc:$? fails:$FAILS token:[$A_TOKEN]"
check "whoami" 200 "$(edge GET h.example.com /api/whoami A_TOKEN)"; echo "still-running fails:$FAILS"
rm -f "$TMP/fail"; st="$(edge GET h.example.com /api/whoami A_TOKEN)"; echo "edge-again:$st"`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('edge:issue-token-failed');
    expect(r.stderr).toContain('tenant a\'s token: tenant-identity IssueToken failed (HTTP 500); this call\'s check fails');
    expect(r.stdout).toContain('FAIL tenant a\'s token: tenant-identity IssueToken failed (HTTP 500)');
    expect(r.stdout).toContain('rc:0 fails:1 token:[]');
    expect(r.stdout).toContain('FAIL whoami: want 200, got issue-token-failed');
    expect(r.stdout).toContain('still-running fails:2');
    expect(r.stdout).toContain('edge-again:200');
    expect(r.stdout).not.toContain('tok-old');
  });

  it('as: a registrar 503 "control plane cannot be read" is retried with a note per retry and counted', () => {
    const r = lib(`REGISTRAR=https://registrar.example.com/
assume() { AK=a; SK=b; ST=c; }
sleep() { :; }
signed() {
  local c; c=$(( $(cat "$TMP/calls" 2>/dev/null || echo 0) + 1 )); echo "$c" >"$TMP/calls"
  if (( c < 3 )); then echo '{"message":"the control plane cannot be read; retry"}' >"$BODY"; echo 503; else echo '{}' >"$BODY"; echo 200; fi
}
st="$(as arn:aws:iam::111111111111:role/op PUT tenants/T1 '{}')"; echo "st:$st retries:$(registrar_retries)"`);
    expect(r.stdout).toContain('st:200 retries:2');
    expect(r.stderr).toContain('registrar 503 control plane unreadable on PUT tenants/T1, attempt 1 of 4');
    expect(r.stderr).toContain('registrar 503 control plane unreadable on PUT tenants/T1, attempt 2 of 4');
    expect(r.stderr).not.toContain('attempt 3 of 4');
  });

  it('api and as: a call that fails before its request leaves no earlier body for a failed check to print', () => {
    const r = lib(`REQ="$TMP/req"; CP_API=https://cp.example.com/; REGISTRAR=https://registrar.example.com/
api_token() { die "the operator could not sign in to the vendor IdP"; }
assume() { return 1; }
echo '{"stale":"earlier answer"}' >"$BODY"
check "api: an external id is set" true "$(api_status accounts/111111111111 .account.externalIdConfigured)"
echo '{"stale":"earlier answer"}' >"$BODY"
check "as: 200" 200 "$(as arn:aws:iam::111111111111:role/op GET tenants/T1)"`);
    expect(r.stdout).toContain('FAIL api: an external id is set: want true, got  (body: )');
    expect(r.stdout).toContain('FAIL as: 200: want 200, got 000 (body: )');
    expect(r.stdout).not.toContain('earlier answer');
  });

  it('state_load: reads only the run-state names, so a hand-edited state.env cannot set PATH', () => {
    const r = lib(`RUN_DIR="$TMP"; printf 'CELL_A=c1\\nPATH=/nowhere\\nIFS=x\\n' >"$TMP/state.env"
state_load; echo "cell:$CELL_A path-kept:$([[ "$PATH" != /nowhere ]] && echo yes)"`);
    expect(r.stdout).toContain('cell:c1 path-kept:yes');
  });

  it('http_status: a curl that fails prints 000 once, whatever its -w wrote', () => {
    const r = lib(`curl() { printf 000; return 7; }
echo "[$(http_status -s -o /dev/null -w '%{http_code}' https://cell.example.com/)]"
curl() { printf 403; }
echo "[$(http_status -s -o /dev/null -w '%{http_code}' https://cell.example.com/)]"`);
    expect(r.stdout).toContain('[000]');
    expect(r.stdout).toContain('[403]');
  });

  it('api: the operator token signed in inside $(...) is kept in a 0600 file and reused by later calls', () => {
    const r = lib(`REQ="$TMP/req"; CP_API=https://cp.example.com/; REGION=eu-central-1; VENDOR_POOL=p; VENDOR_OPERATOR_CLIENT=c; OPERATOR_PASSWORD=pw
aws() { echo x >>"$TMP/signins"; echo "id-token-$(wc -l <"$TMP/signins" | tr -d ' ')"; }
curl() { echo 200; }
a="$(api GET cells)"; b="$(api GET cells)"; c="$(api_status cells .x)"
echo "signins:$(wc -l <"$TMP/signins" | tr -d ' ')"`);
    expect(r.stdout).toContain('signins:1');
    expect((fs.statSync(path.join(tmp, 'cp-token')).mode % 0o1000).toString(8)).toBe('600');
  });
});
