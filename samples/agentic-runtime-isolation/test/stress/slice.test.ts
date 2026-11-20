// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { CELL_ACCOUNT, drawsOf } from './slice-cli';
import { STRESS_TIERS } from './tiers';
import { overdraws, parseDraws, sumDraws } from '../../../../stress/src/budget';
import { parseDeclaration } from '../../../../stress/src/slice';
import { TIERS } from '../../../../stress/src/tiers';

const STRESS_DIR = path.join(__dirname, '..', '..', 'scripts', 'stress');
const SLICE_SH = path.join(STRESS_DIR, 'slice.sh');
const declaration = parseDeclaration(fs.readFileSync(path.join(STRESS_DIR, 'slice.json'), 'utf8'), 'slice.json');
const hasJq = spawnSync('jq', ['--version']).status === 0;

type Pace = { owned: number; sharers: number; rps: number; intervalMs: number };
/** k6/noisy-pace.js has no k6 import, so it runs here as it is, with its `export` keywords dropped. */
const PACE: {
  steadyPace?: (id: number, o: { vus: number; slots: number; tenants: number; rate: number; seconds: number }) => Pace;
  noisyIntervalMs?: (vus: number, perMinute: number) => number;
  minSteadySent?: (expected: number) => number;
} = {};
vm.runInNewContext(fs.readFileSync(path.join(STRESS_DIR, 'k6', 'noisy-pace.js'), 'utf8').replace(/^export /gm, ''), PACE);

/** The environment the runner gives a verb (stress/README.md), for one tier. */
function sliceEnv(tier: 'small' | 'medium' | 'large', extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    STRESS_TIER: tier,
    STRESS_TIER_JSON: JSON.stringify(TIERS[tier]),
    STRESS_RUN_ID: 'test-run',
    STRESS_PREFIX: 'StressTest',
    STRESS_HOME: path.join(os.tmpdir(), 'slice-test-home'),
    STRESS_MODE: 'slice',
    ...extra,
  };
}

describe('slice.json', () => {
  it('names the sample and its scenarios S1 to S7 on the quotas the budget draws on', () => {
    expect(declaration.name).toBe('agentic-runtime-isolation');
    expect(declaration.scenarios).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(declaration.needs).toEqual([]);
  });

  it('has a k6 script for every scenario it declares, as slice.sh run maps them', () => {
    const script = fs.readFileSync(SLICE_SH, 'utf8');
    for (const scenario of declaration.scenarios) {
      const m = new RegExp(`^\\s*${scenario}\\) k6_file=(\\S+\\.js) ;;`, 'm').exec(script);
      expect(m).not.toBeNull();
      expect(fs.existsSync(path.join(STRESS_DIR, 'k6', m![1]))).toBe(true);
    }
  });

  it('is the scenario id every k6 script writes its record under', () => {
    for (const scenario of declaration.scenarios) {
      const files = fs.readdirSync(path.join(STRESS_DIR, 'k6')).filter((f) => new RegExp(`^${scenario.toLowerCase()}-.*\\.js$`).test(f));
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(STRESS_DIR, 'k6', files[0]), 'utf8')).toContain(`summarize(data, '${scenario}')`);
    }
  });
});

describe('budget', () => {
  it.each(Object.keys(STRESS_TIERS) as ('small' | 'medium' | 'large')[])('draws only on declared quotas at %s, in the one cell account', (name) => {
    const draws = parseDraws('agentic-runtime-isolation', JSON.stringify({ draws: drawsOf(STRESS_TIERS[name]) }), TIERS[name].cellAccounts);
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      expect(declaration.quotas).toContain(d.quota);
      expect(d.account).toBe(CELL_ACCOUNT);
    }
    // Every declared quota has a draw: a quota nobody draws on is a declaration that lies.
    expect(new Set(draws.map((d) => d.quota))).toEqual(new Set(declaration.quotas));
  });

  it('fits the service defaults at small and medium', () => {
    for (const name of ['small', 'medium'] as const) {
      expect(overdraws(sumDraws(drawsOf(STRESS_TIERS[name])))).toEqual([]);
    }
  });

  it('asks for a raised Lambda concurrency quota at large (F-17)', () => {
    const over = overdraws(sumDraws(drawsOf(STRESS_TIERS.large)));
    expect(over.map((o) => o.quota)).toContain('lambda-concurrency');
    const lambda = drawsOf(STRESS_TIERS.large).find((d) => d.quota === 'lambda-concurrency')!;
    expect(lambda.amount).toBe(800 + 1000 + 100);
  });

  it('keeps the sessions the scenarios walk within the seeded tenants', () => {
    for (const name of ['small', 'medium', 'large'] as const) {
      const sessions = drawsOf(STRESS_TIERS[name]).find((d) => d.quota === 'agentcore-active-sessions')!;
      expect(sessions.amount).toBeLessThanOrEqual(STRESS_TIERS[name].tenantsSeeded);
    }
  });
});

describe('slice.sh', () => {
  it('prints the budget without credentials and with an empty HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-budget-'));
    try {
      const r = spawnSync('bash', [SLICE_SH, 'budget'], {
        env: { ...sliceEnv('small'), HOME: home, AWS_EC2_METADATA_DISABLED: 'true' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(r.status).toBe(0);
      const draws = parseDraws('agentic-runtime-isolation', r.stdout, 1);
      expect(draws).toEqual(drawsOf(STRESS_TIERS.small));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 150_000);

  it('refuses the platform mode for every verb but budget', () => {
    for (const verb of ['deploy', 'seed', 'run', 'collect', 'teardown']) {
      const r = spawnSync('bash', [SLICE_SH, verb, 'S1'], { env: sliceEnv('small', { STRESS_MODE: 'platform', AWS_REGION: 'eu-central-1' }), encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('control plane');
    }
  });

  it('refuses a prefix that could name an integration-test stack', () => {
    const r = spawnSync('bash', [SLICE_SH, 'deploy'], { env: sliceEnv('small', { STRESS_PREFIX: 'TenantIdentityX' }), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('TenantIdentity');
  });

  it('refuses a missing runner variable and an unknown verb', () => {
    const missing = spawnSync('bash', [SLICE_SH, 'budget'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(missing.status).toBe(2);
    const unknown = spawnSync('bash', [SLICE_SH, 'restart'], { env: sliceEnv('small'), encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });

  it('refuses a missing STRESS_RUN_ID, and the variables run and collect read', () => {
    const noRunId = sliceEnv('small');
    delete noRunId.STRESS_RUN_ID;
    const r = spawnSync('bash', [SLICE_SH, 'budget'], { env: noRunId, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('STRESS_RUN_ID is not set');
    const run = spawnSync('bash', [SLICE_SH, 'run', 'S1'], { env: sliceEnv('small', { AWS_REGION: 'eu-central-1' }), encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('STRESS_RESULTS is not set');
    // k6.sh and lib.js need STRESS_COMMIT; run checks it before S2's recipe changes anything.
    const noCommit = spawnSync('bash', [SLICE_SH, 'run', 'S2'], { env: sliceEnv('small', { AWS_REGION: 'eu-central-1', STRESS_RESULTS: os.tmpdir() }), encoding: 'utf8' });
    expect(noCommit.status).toBe(2);
    expect(noCommit.stderr).toContain('slice.sh run: STRESS_COMMIT is not set');
    const collect = spawnSync('bash', [SLICE_SH, 'collect'], { env: sliceEnv('small', { AWS_REGION: 'eu-central-1', STRESS_RESULTS: os.tmpdir() }), encoding: 'utf8' });
    expect(collect.status).toBe(2);
    expect(collect.stderr).toContain('STRESS_COMMIT is not set');
  });

  it.each([
    ['budget', 'extra'],
    ['deploy', 'extra'],
    ['seed', '--tenants'],
    ['collect', 'S1'],
    ['run', 'S1', 'extra'],
    ['run'],
    ['teardown', '--fixture'],
    ['teardown', '--fixtures', 'extra'],
  ])('refuses an argument the verb does not take: %s %s', (...args) => {
    const r = spawnSync('bash', [SLICE_SH, ...args], { env: sliceEnv('small', { AWS_REGION: 'eu-central-1' }), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unexpected argument|one scenario id/);
  });

  it('refuses S2 when this run holds no S1 record (S2 reuses its conversations, F-2)', () => {
    const results = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-s2-'));
    try {
      const r = spawnSync('bash', [SLICE_SH, 'run', 'S2'], {
        env: sliceEnv('small', { AWS_REGION: 'eu-central-1', STRESS_RESULTS: results, STRESS_COMMIT: 'abc1234' }),
        encoding: 'utf8',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('agentic-runtime-isolation.S1.json');
      expect(r.stderr).toContain('run S1 first');
    } finally {
      fs.rmSync(results, { recursive: true, force: true });
    }
  });

  describe('teardown flags', () => {
    // A copy of slice.sh in a sample-shaped folder whose teardown.sh only prints its arguments.
    let root: string;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-teardown-'));
      const scripts = path.join(root, 'scripts', 'stress');
      fs.mkdirSync(scripts, { recursive: true });
      fs.mkdirSync(path.join(root, 'src', 'smithy'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"slice-teardown-test"}');
      fs.copyFileSync(SLICE_SH, path.join(scripts, 'slice.sh'));
      fs.copyFileSync(path.join(STRESS_DIR, 'window.sh'), path.join(scripts, 'window.sh'));
      fs.writeFileSync(path.join(scripts, 'teardown.sh'), '#!/usr/bin/env bash\necho "teardown.sh [$*]"\n', { mode: 0o755 });
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    function teardown(tier: 'small' | 'medium' | 'large', ...args: string[]): string {
      const r = spawnSync('bash', [path.join(root, 'scripts', 'stress', 'slice.sh'), 'teardown', ...args], {
        env: sliceEnv(tier, { AWS_REGION: 'eu-central-1' }),
        encoding: 'utf8',
      });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      return r.stdout.trim();
    }

    it('deletes the tenants at the tiers that onboard every run', () => {
      expect(teardown('small')).toBe('teardown.sh [--tenants]');
      expect(teardown('medium')).toBe('teardown.sh [--tenants]');
    });

    it('keeps the fleet at large unless --fixtures is passed', () => {
      expect(teardown('large')).toBe('teardown.sh []');
      expect(teardown('large', '--fixtures')).toBe('teardown.sh [--tenants]');
      expect(teardown('small', '--fixtures')).toBe('teardown.sh [--tenants]');
    });
  });
});

/**
 * teardown.sh against a stubbed account: `aws` and `npx` on PATH read and change a folder of
 * fake stacks and log groups, and the shared driver's teardown.sh is a stub that removes the
 * driver stack and leaves its S3 auto-delete handler's log group behind, as the real one does.
 */
(hasJq ? describe : describe.skip)('teardown.sh (log groups across a rerun, ADR-0052)', () => {
  const AWS_STUB = `#!/usr/bin/env bash
set -u
F="$FAKE"
svc="$1"; op="$2"; shift 2
name="" query="" prefix="" lg="" ppath="" rtid=""
while (( $# )); do
  case "$1" in
    --stack-name) name="$2"; shift 2 ;;
    --query) query="$2"; shift 2 ;;
    --log-group-name-prefix) prefix="$2"; shift 2 ;;
    --log-group-name) lg="$2"; shift 2 ;;
    --path) ppath="$2"; shift 2 ;;
    --agent-runtime-id) rtid="$2"; shift 2 ;;
    --stack-status-filter) shift; while (( $# )) && [[ "$1" != --* ]]; do shift; done ;;
    *) shift ;;
  esac
done
touch "$F/logs.txt" "$F/params.txt"
case "$svc $op" in
  "cloudformation describe-stacks")
    [[ -d "$F/stacks/$name" ]] || { echo "Stack with id $name does not exist" >&2; exit 254; }
    if [[ "$query" == *StackStatus* ]]; then echo CREATE_COMPLETE
    elif [[ "$query" == *RegistryPrefix* && -f "$F/stacks/$name/RegistryPrefix" ]]; then cat "$F/stacks/$name/RegistryPrefix"
    elif [[ "$query" == *RestApiId* && -f "$F/stacks/$name/RestApiId" ]]; then cat "$F/stacks/$name/RestApiId"
    else echo None; fi ;;
  "cloudformation list-stacks")
    names=""
    for d in "$F"/stacks/*/; do
      [[ -d "$d" ]] || continue
      n="$(basename "$d")"
      if [[ "$query" == *-ingress* || "$n" == *-agents-* ]]; then names="\${names:+\${names}$(printf '\\t')}$n"; fi
    done
    echo "$names" ;;
  "cloudformation list-stack-resources")
    d="$F/stacks/$name"
    [[ -d "$d" ]] || exit 254
    case "$query" in
      *AWS::Logs::LogGroup*) if [[ -f "$d/loggroups" ]]; then paste -sd '\\t' "$d/loggroups"; fi ;;
      *AWS::Lambda::Function*) if [[ -f "$d/functions" ]]; then cat "$d/functions"; fi ;;
      *AWS::BedrockAgentCore::Runtime*) if [[ -f "$d/runtimes" ]]; then paste -sd '\\t' "$d/runtimes"; fi ;;
    esac ;;
  "ssm get-parameters-by-path")
    awk -v p="$ppath" 'index($0, p) == 1' "$F/params.txt" | paste -sd '\\t' - ;;
  "bedrock-agentcore-control get-agent-runtime")
    if [[ -e "$F/live-runtimes/$rtid" ]]; then echo "$rtid"
    else echo "An error occurred (ResourceNotFoundException) when calling the GetAgentRuntime operation" >&2; exit 254; fi ;;
  "logs describe-log-groups")
    if [[ "$query" == *"logGroupName=="* ]]; then grep -Fx -- "$prefix" "$F/logs.txt" || true
    else awk -v p="$prefix" 'index($0, p) == 1' "$F/logs.txt" | paste -sd '\\t' -; fi ;;
  "logs delete-log-group")
    grep -Fxq -- "$lg" "$F/logs.txt" || exit 254
    grep -Fxv -- "$lg" "$F/logs.txt" >"$F/logs.new" || true
    mv "$F/logs.new" "$F/logs.txt"
    echo "$lg" >>"$F/deleted.txt" ;;
esac
exit 0
`;
  const NPX_STUB = `#!/usr/bin/env bash
F="$FAKE"
if [[ "$1" == cdk && "$2" == synth ]]; then
  out=""
  while (( $# )); do [[ "$1" == --output ]] && out="$2"; shift; done
  mkdir -p "$out"
  for d in "$F"/stacks/*/; do [[ -d "$d" ]] && echo '{}' >"$out/$(basename "$d").template.json"; done
  exit 0
fi
if [[ "$1" == cdk && "$4" == destroy ]]; then
  s="$5"
  if [[ -e "$F/fail-destroy-$s" ]]; then echo "Error: $s DELETE_FAILED"; exit 1; fi
  if [[ -f "$F/stacks/$s/loggroups" && ! -e "$F/leak" ]]; then
    grep -Fxv -f "$F/stacks/$s/loggroups" "$F/logs.txt" >"$F/logs.new" || true
    mv "$F/logs.new" "$F/logs.txt"
  fi
  if [[ -f "$F/stacks/$s/latelogs" ]]; then cat "$F/stacks/$s/latelogs" >>"$F/logs.txt"; fi
  rm -r "$F/stacks/$s"
  exit 0
fi
exit 1
`;
  const DRIVER_STUB = `#!/usr/bin/env bash
rm -r "$FAKE/stacks/\${STRESS_PREFIX}-driver"
echo "/aws/lambda/\${STRESS_PREFIX}-driver-CustomS3AutoDeleteObjectsCustomRes-abc" >>"$FAKE/logs.txt"
echo "stack=\${STRESS_PREFIX}-driver destroy_seconds=1"
`;
  const P = 'StressT';
  const PROVIDER_GROUP = `/aws/lambda/${P}-driver-CustomS3AutoDeleteObjectsCustomRes-abc`;
  const OWNED_GROUP = `${P}-ingress-AccessLogs-xyz`;
  let root: string;
  let fake: string;
  let state: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-rerun-'));
    const scripts = path.join(root, 'samples', 'sample', 'scripts');
    fs.mkdirSync(path.join(scripts, 'stress'), { recursive: true });
    fs.copyFileSync(path.join(STRESS_DIR, 'teardown.sh'), path.join(scripts, 'stress', 'teardown.sh'));
    fs.copyFileSync(path.join(STRESS_DIR, '..', 'lib.sh'), path.join(scripts, 'lib.sh'));
    fs.mkdirSync(path.join(root, 'stress', 'driver'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stress', 'driver', 'teardown.sh'), DRIVER_STUB, { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'aws'), AWS_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin', 'npx'), NPX_STUB, { mode: 0o755 });
    fake = path.join(root, 'fake');
    state = path.join(root, 'state');
    fs.mkdirSync(path.join(fake, 'stacks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'home'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function stack(name: string, files: {
    functions?: string[];
    loggroups?: string[];
    runtimes?: string[];
    latelogs?: string[];
    RegistryPrefix?: string;
    RestApiId?: string;
  }) {
    const d = path.join(fake, 'stacks', name);
    fs.mkdirSync(d);
    for (const [k, v] of Object.entries(files)) {
      fs.writeFileSync(path.join(d, k), (Array.isArray(v) ? v.join('\n') : v) + '\n');
    }
  }
  function teardown() {
    return spawnSync('bash', [path.join(root, 'samples', 'sample', 'scripts', 'stress', 'teardown.sh')], {
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        HOME: path.join(root, 'home'),
        AWS_REGION: 'eu-central-1',
        STRESS_SCALE: 'small',
        STRESS_PREFIX: P,
        STRESS_STATE_DIR: state,
        FAKE: fake,
      },
      encoding: 'utf8',
    });
  }
  const logs = () => fs.readFileSync(path.join(fake, 'logs.txt'), 'utf8').split('\n').filter((l) => l);
  const deleted = () => (fs.existsSync(path.join(fake, 'deleted.txt')) ? fs.readFileSync(path.join(fake, 'deleted.txt'), 'utf8').split('\n').filter((l) => l) : []);
  const LIST = () => path.join(state, 'teardown-state');
  const recorded = () => fs.readFileSync(LIST(), 'utf8').split('\n').filter((l) => l);

  it("removes a destroyed driver's provider log group on the rerun after a later destroy failed", () => {
    stack(`${P}-driver`, {
      functions: [
        `CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F\t${P}-driver-CustomS3AutoDeleteObjectsCustomRes-abc`,
        `HostReady1A2B3C4D\t${P}-driver-HostReady-1`,
      ],
    });
    stack(`${P}-ingress`, {
      functions: [`AWS679f53fac002430cb0da5b7982bd22872D164C4C\t${P}-ingress-AWS679f53fac002430cb0da5b7982-def`],
      loggroups: [OWNED_GROUP],
    });
    fs.writeFileSync(path.join(fake, 'logs.txt'), `${OWNED_GROUP}\n`);
    fs.writeFileSync(path.join(fake, `fail-destroy-${P}-ingress`), '');

    const first = teardown();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`FAILED: destroy ${P}-ingress`);
    expect(fs.existsSync(path.join(fake, 'stacks', `${P}-driver`))).toBe(false);
    expect(logs()).toContain(PROVIDER_GROUP);
    expect(recorded()).toEqual([
      `owned ${OWNED_GROUP}`,
      `provider ${PROVIDER_GROUP}`,
      `provider /aws/lambda/${P}-ingress-AWS679f53fac002430cb0da5b7982-def`,
    ]);

    fs.rmSync(path.join(fake, `fail-destroy-${P}-ingress`));
    const rerun = teardown();
    expect(rerun.stderr).toBe('');
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain('CDK provider function log groups: 2 functions, 1 groups removed');
    expect(rerun.stdout).toContain('leftovers: none');
    expect(logs()).toEqual([]);
    expect(deleted()).toEqual([PROVIDER_GROUP]);
    expect(fs.existsSync(LIST())).toBe(false);
  });

  it('reports a log group a destroyed stack owned as a leak, never deletes it, and keeps reporting it on a rerun', () => {
    stack(`${P}-ingress`, { loggroups: [OWNED_GROUP] });
    fs.writeFileSync(path.join(fake, 'logs.txt'), `${OWNED_GROUP}\n`);
    fs.writeFileSync(path.join(fake, 'leak'), '');

    const first = teardown();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`log group ${OWNED_GROUP} (the stack owned it: a construct leak, ADR-0019)`);
    expect(fs.existsSync(LIST())).toBe(true);

    const rerun = teardown();
    expect(rerun.status).toBe(1);
    expect(rerun.stdout).toContain('finishing the leftover check of an earlier teardown');
    expect(rerun.stderr).toContain(`log group ${OWNED_GROUP} (the stack owned it: a construct leak, ADR-0019)`);
    expect(logs()).toEqual([OWNED_GROUP]);
    expect(deleted()).toEqual([]);
    expect(fs.existsSync(LIST())).toBe(true);
  });

  it('keeps failing on a registry parameter after the stacks are gone, and passes and forgets the run once it is removed', () => {
    const registry = `/stress/${P}/`;
    const param = `${registry}agents/a1`;
    stack(`${P}-ingress`, { runtimes: [`${P}IngressRt-AAAA`], RegistryPrefix: registry, RestApiId: 'abc123' });
    fs.writeFileSync(path.join(fake, 'params.txt'), `${param}\n`);

    const first = teardown();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`parameters ${param}`);
    expect(fs.existsSync(path.join(fake, 'stacks', `${P}-ingress`))).toBe(false);
    expect(recorded()).toEqual([`registry ${registry}`, 'restapi abc123', `runtime ${P}IngressRt-AAAA`]);

    const rerun = teardown();
    expect(rerun.status).toBe(1);
    expect(rerun.stdout).toContain('finishing the leftover check of an earlier teardown');
    expect(rerun.stdout).toContain('runtime log groups: 1 runtimes');
    expect(rerun.stderr).toContain(`parameters ${param}`);
    expect(fs.existsSync(LIST())).toBe(true);

    fs.writeFileSync(path.join(fake, 'params.txt'), '');
    const last = teardown();
    expect(last.stderr).toBe('');
    expect(last.status).toBe(0);
    expect(last.stdout).toContain('leftovers: none');
    expect(fs.existsSync(LIST())).toBe(false);
  });

  it("still checks the destroyed agents' runtimes and their log groups on the rerun after the ingress destroy failed", () => {
    const agentRt = `${P}AgentRt-BBBB`;
    const agentGroup = `/aws/bedrock-agentcore/runtimes/${agentRt}-DEFAULT`;
    stack(`${P}-agents-1`, { runtimes: [agentRt], latelogs: [agentGroup] });
    stack(`${P}-ingress`, { runtimes: [`${P}IngressRt-AAAA`] });
    fs.writeFileSync(path.join(fake, `fail-destroy-${P}-ingress`), '');
    fs.mkdirSync(path.join(fake, 'live-runtimes'));
    fs.writeFileSync(path.join(fake, 'live-runtimes', agentRt), '');

    const first = teardown();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`FAILED: destroy ${P}-ingress`);
    expect(fs.existsSync(path.join(fake, 'stacks', `${P}-agents-1`))).toBe(false);
    expect(logs()).toEqual([agentGroup]);
    expect(recorded()).toEqual([`runtime ${P}AgentRt-BBBB`, `runtime ${P}IngressRt-AAAA`]);

    fs.rmSync(path.join(fake, `fail-destroy-${P}-ingress`));
    const rerun = teardown();
    expect(rerun.status).toBe(1);
    expect(rerun.stdout).toContain('runtime log groups: 2 runtimes, 1 leftover groups removed');
    expect(rerun.stderr).toContain(`agent runtime ${agentRt}`);
    expect(deleted()).toEqual([agentGroup]);
    expect(fs.existsSync(LIST())).toBe(true);

    fs.rmSync(path.join(fake, 'live-runtimes', agentRt));
    const last = teardown();
    expect(last.stderr).toBe('');
    expect(last.status).toBe(0);
    expect(last.stdout).toContain('finishing the leftover check of an earlier teardown');
    expect(last.stdout).toContain('leftovers: none');
    expect(fs.existsSync(LIST())).toBe(false);
  });

  it('has nothing to do with no stacks and no list from an earlier teardown', () => {
    const r = teardown();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to destroy');
  });
});

(hasJq ? describe : describe.skip)('caps.jq (the driver 429s per tenant)', () => {
  function caps(summary: object): Record<string, number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
    try {
      const file = path.join(dir, 'summary.json');
      fs.writeFileSync(file, JSON.stringify(summary));
      const r = spawnSync('jq', ['-c', '-f', path.join(STRESS_DIR, 'caps.jq'), file], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads one count per tagged sub-metric in the handleSummary layout', () => {
    expect(caps({
      metrics: {
        'tenant_429{tenant:8f14e45f-ea7b-4c1e-9d0a-1b2c3d4e5f60}': { type: 'counter', contains: 'default', values: { count: 17, rate: 0.28 }, thresholds: { 'count>=0': { ok: true } } },
        'tenant_429{tenant:t2}': { type: 'counter', values: { count: 0, rate: 0 } },
        'tenant_429': { type: 'counter', values: { count: 17, rate: 0.28 } },
        'status_429': { type: 'counter', values: { count: 17, rate: 0.28 } },
      },
    })).toEqual({ '8f14e45f-ea7b-4c1e-9d0a-1b2c3d4e5f60': 17, 't2': 0 });
  });

  it('reads the summary-export layout too', () => {
    expect(caps({ metrics: { 'tenant_429{tenant:a}': { count: 4, rate: 1 } } })).toEqual({ a: 4 });
  });

  it('is empty for a summary without them, which caps every tenant at 0', () => {
    expect(caps({ metrics: {} })).toEqual({});
    expect(caps({})).toEqual({});
  });
});

describe('noisy-pace.js (S3 pacing)', () => {
  const ctx = PACE;
  const steadyPace = ctx.steadyPace!;

  it.each([
    [10, 19, 10], [10, 20, 10], [2, 1, 2], [5, 3, 1], [50, 199, 100], [10, 10, 10], [7, 100, 3], [500, 999, 500],
  ])('splits steadyRps evenly over the steady tenants (%i VUs, %i tenants, %i rps)', (vus, tenants, rate) => {
    const slots = Math.min(vus, tenants);
    const s = Math.max(1, Math.min(slots, tenants));
    const perTenant = new Array<number>(tenants).fill(0);
    let total = 0;
    for (let id = 1; id <= vus; id++) {
      const p = steadyPace(id, { vus, slots, tenants, rate, seconds: 60 });
      // The VU owns the tenants lib.js adopt() gives its slot: position i with i % s === slot.
      const mine = [...perTenant.keys()].filter((i) => i % s === (id - 1) % s);
      expect(p.owned).toBe(mine.length);
      expect(p.intervalMs).toBeCloseTo(1000 / p.rps, 6);
      for (const i of mine) perTenant[i] += p.rps / p.owned;
      total += p.rps;
    }
    expect(total).toBeCloseTo(rate, 6);
    for (const r of perTenant) expect(r).toBeCloseTo(rate / tenants, 6);
  });

  it('keeps every steady tenant under its 60-a-minute limit at the small tier shape', () => {
    // small: 10 rps over 19 steady tenants, 10 VUs.
    for (let id = 1; id <= 10; id++) {
      const p = steadyPace(id, { vus: 10, slots: 10, tenants: 19, rate: 10, seconds: 60 });
      expect((p.rps / p.owned) * 60).toBeLessThan(60);
    }
  });

  it('paces the noisy VUs to the noisy rate', () => {
    expect(ctx.noisyIntervalMs!(10, 600)).toBe(1000);
    expect(ctx.noisyIntervalMs!(2, 600)).toBe(200);
  });

  it('is the threshold s3-noisy.js sets on steady_sent', () => {
    expect(fs.readFileSync(path.join(STRESS_DIR, 'k6', 's3-noisy.js'), 'utf8')).toContain('steady_sent: [`count>=${minSteadySent(rate * seconds)}`]');
    expect(ctx.minSteadySent!(600)).toBe(570);
    expect(ctx.minSteadySent!(157)).toBe(150);
  });
});

(hasJq ? describe : describe.skip)('attribute.jq (P-7)', () => {
  type Attribution = { byTenantReason: { tenant: string; reason: string; count: number }[]; unattributed: number };
  function attribute(seen: number, rows: object[], caps: Record<string, number> = {}): Attribution {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribute-'));
    try {
      const file = path.join(dir, 'rows.json');
      fs.writeFileSync(file, JSON.stringify(rows));
      const r = spawnSync('jq', ['-n', '-c', '--argjson', 'seen', String(seen), '--argjson', 'caps', JSON.stringify(caps), '--slurpfile', 'rows', file, '-f', path.join(STRESS_DIR, 'attribute.jq')], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('attributes every refusal a log line names a tenant for, by tenant and reason', () => {
    const out = attribute(7, [
      { tenantId: 'b', reason: 'tenant_limit', n: '5' },
      { tenantId: 'a', reason: 'tenant_limit', n: '1' },
      { tenantId: 'a', reason: 'entitlement', n: '1' },
    ]);
    expect(out.unattributed).toBe(0);
    expect(out.byTenantReason).toEqual([
      { tenant: 'a', reason: 'entitlement', count: 1 },
      { tenant: 'a', reason: 'tenant_limit', count: 1 },
      { tenant: 'b', reason: 'tenant_limit', count: 5 },
    ]);
  });

  it('leaves unattributed what the driver saw and no line with a tenant accounts for', () => {
    const out = attribute(10, [
      { tenantId: 'a', reason: 'tenant_limit', n: '6' },
      { reason: 'registry_unavailable', n: '3' },
      { tenantId: '', reason: 'unknown_backend', n: '2' },
    ]);
    expect(out.unattributed).toBe(4);
    expect(out.byTenantReason).toEqual([{ tenant: 'a', reason: 'tenant_limit', count: 6 }]);
  });

  it('never goes below zero when the logs hold more than the driver saw', () => {
    expect(attribute(2, [{ tenantId: 'a', reason: 'tenant_limit', n: '3' }]).unattributed).toBe(0);
  });

  it('names a refusal with no reason `unknown` and handles no rows at all', () => {
    expect(attribute(1, [{ tenantId: 'a', n: '1' }]).byTenantReason).toEqual([{ tenant: 'a', reason: 'unknown', count: 1 }]);
    expect(attribute(3, [])).toEqual({ byTenantReason: [], unattributed: 3 });
  });

  it("caps a tenant's 429 lines at the driver's 429 count for it, so its excess cannot hide another tenant's refusal", () => {
    // The driver saw 5 for a and 5 for b; the window caught 8 lines for a and only 2 for b.
    const rows = [
      { tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '8' },
      { tenantId: 'b', reason: 'tenant_rate_limited', status: '429', n: '2' },
    ];
    const out = attribute(10, rows, { a: 5, b: 5 });
    expect(out.unattributed).toBe(3);
    // byTenantReason stays what was logged.
    expect(out.byTenantReason).toEqual([
      { tenant: 'a', reason: 'tenant_rate_limited', count: 8 },
      { tenant: 'b', reason: 'tenant_rate_limited', count: 2 },
    ]);
  });

  it('credits no 429 line for a tenant the driver counted no 429 for (fail closed)', () => {
    expect(attribute(3, [{ tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '3' }]).unattributed).toBe(3);
  });

  it('credits lines with another status as logged', () => {
    const rows = [
      { tenantId: 'a', reason: 'entitlement_denied', status: '403', n: '2' },
      { tenantId: 'a', reason: 'tenant_rate_limited', status: '429', n: '4' },
    ];
    expect(attribute(6, rows, { a: 4 }).unattributed).toBe(0);
    expect(attribute(6, rows, { a: 1 }).unattributed).toBe(3);
  });
});

(hasJq ? describe : describe.skip)('noisy.jq (S3 noisy neighbour)', () => {
  type Noisy = { noisy429: number; others429: number; otherTenants: number; untagged429: number; pass: boolean };
  function noisy(id: string, rows: object[]): Noisy {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noisy-'));
    try {
      const file = path.join(dir, 'rows.json');
      fs.writeFileSync(file, JSON.stringify(rows));
      const r = spawnSync('jq', ['-n', '-c', '--arg', 'noisy', id, '--slurpfile', 'rows', file, '-f', path.join(STRESS_DIR, 'noisy.jq')], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const m1 = '2026-11-19 16:24:00.000';
  const m2 = '2026-11-19 16:25:00.000';

  it('passes when only the noisy tenant is refused', () => {
    expect(noisy('n', [{ tenantId: 'n', minute: m1, n: '149' }, { tenantId: 'n', minute: m2, n: '323' }]))
      .toEqual({ noisy429: 472, others429: 0, otherTenants: 0, untagged429: 0, pass: true });
  });

  it('fails when any other tenant got a 429 (a steady tenant pushed to its limit)', () => {
    const out = noisy('n', [{ tenantId: 'n', minute: m1, n: '472' }, { tenantId: 's', minute: m2, n: '17' }]);
    expect(out).toEqual({ noisy429: 472, others429: 17, otherTenants: 1, untagged429: 0, pass: false });
  });

  it('counts untagged 429 lines against the others, but not as a tenant', () => {
    const out = noisy('n', [{ tenantId: 'n', minute: m1, n: '5' }, { minute: m1, n: '1' }, { tenantId: '', minute: m2, n: '2' }]);
    expect(out).toEqual({ noisy429: 5, others429: 3, otherTenants: 0, untagged429: 3, pass: false });
  });

  it('fails when the noisy tenant is unknown or was never refused', () => {
    expect(noisy('', [{ tenantId: 'n', minute: m1, n: '5' }]).pass).toBe(false);
    expect(noisy('', [{ minute: m1, n: '5' }])).toEqual({ noisy429: 0, others429: 5, otherTenants: 0, untagged429: 5, pass: false });
    expect(noisy('n', []).pass).toBe(false);
  });
});

describe('window.sh (CloudWatch minutes, ADR-0052)', () => {
  const WINDOW_SH = path.join(STRESS_DIR, 'window.sh');
  function call(fn: string, ...args: number[]): number[] {
    const r = spawnSync('bash', ['-c', `source "$0"; ${fn} "$@"`, WINDOW_SH, ...args.map(String)], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return r.stdout.trim().split(' ').map(Number);
  }
  const at = (hh: number, mm: number, ss: number) => Date.UTC(2026, 10, 19, hh, mm, ss) / 1000;

  it('runs from the start minute to one minute past the end minute (API Gateway stamps a minute late)', () => {
    // S3 of the 2026-11-19 run: 18:04:05 .. 18:06:42 holds its own 18:07 datapoints.
    expect(call('metric_window', at(18, 4, 5), at(18, 6, 42))).toEqual([at(18, 4, 0), at(18, 8, 0)]);
    expect(call('metric_window', at(18, 4, 0), at(18, 6, 0))).toEqual([at(18, 4, 0), at(18, 8, 0)]);
  });

  it('starts the next scenario 3 s past the previous metric window, on a fresh minute', () => {
    expect(call('start_at', at(18, 6, 42), at(18, 6, 50))).toEqual([at(18, 8, 3)]);
    expect(call('start_at', at(18, 6, 42), at(18, 9, 30))).toEqual([at(18, 10, 3)]);
    expect(call('start_at', at(18, 6, 42), at(18, 9, 2))).toEqual([at(18, 9, 2)]);
  });

  it('only waits for a fresh minute when there is no previous scenario', () => {
    expect(call('start_at', 0, at(18, 0, 2))).toEqual([at(18, 0, 2)]);
    expect(call('start_at', 0, at(18, 0, 20))).toEqual([at(18, 1, 3)]);
  });

  it('never lets two consecutive scenarios share a metric minute', () => {
    for (let end = at(18, 0, 0); end < at(18, 2, 0); end += 7) {
      const [, mend] = call('metric_window', at(17, 58, 0), end);
      const next = call('start_at', end, end + 1)[0];
      const [mstart] = call('metric_window', next, next + 60);
      expect(mstart).toBeGreaterThanOrEqual(mend);
    }
  });

  (hasJq ? it : it.skip)('parses a record timestamp without GNU date, and fails loudly on a bad one', () => {
    function sh(fn: string, arg: string) {
      return spawnSync('bash', ['-c', `source "$0"; ${fn} "$1"`, WINDOW_SH, arg], { encoding: 'utf8' });
    }
    expect(sh('iso_epoch', '2026-11-19T18:06:42.123Z').stdout.trim()).toBe(String(at(18, 6, 42)));
    expect(sh('iso_epoch', '2026-11-19T18:06:42Z').stdout.trim()).toBe(String(at(18, 6, 42)));
    expect(sh('epoch_iso', String(at(18, 6, 42))).stdout.trim()).toBe('2026-11-19T18:06:42Z');
    for (const bad of ['', 'yesterday', '2026-11-19 18:06:42']) {
      const r = sh('iso_epoch', bad);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('not a UTC ISO 8601 timestamp');
    }
    expect(sh('epoch_iso', 'soon').status).not.toBe(0);
  });
});

(hasJq ? describe : describe.skip)('delivered.jq (S3 steady load)', () => {
  function delivered(summary: object): { sent: number; expected: number; behind: number; shortPct: number; pass: boolean } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivered-'));
    try {
      const file = path.join(dir, 'summary.json');
      fs.writeFileSync(file, JSON.stringify(summary));
      const r = spawnSync('jq', ['-c', '-f', path.join(STRESS_DIR, 'delivered.jq'), file], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const counters = (expected: number, sent: number, behind?: number) => ({
    metrics: {
      steady_expected: { values: { count: expected } },
      steady_sent: { values: { count: sent } },
      ...(behind === undefined ? {} : { 'iteration_skipped{reason:behind}': { values: { count: behind } } }),
    },
  });

  it('passes at 5 % short and fails just past it', () => {
    expect(delivered(counters(6000, 5700, 300))).toEqual({ sent: 5700, expected: 6000, behind: 300, shortPct: 5, pass: true });
    expect(delivered(counters(6000, 5699)).pass).toBe(false);
  });

  it('passes when the VUs sent more than expected (one request in the graceful stop)', () => {
    expect(delivered(counters(6000, 6012))).toEqual({ sent: 6012, expected: 6000, behind: 0, shortPct: 0, pass: true });
  });

  it('reads the summary-export layout too', () => {
    expect(delivered({ metrics: { steady_expected: { count: 100 }, steady_sent: { count: 99 } } }).pass).toBe(true);
  });

  it('fails closed on a summary without the counters', () => {
    expect(delivered({ metrics: {} })).toEqual({ sent: 0, expected: 0, behind: 0, shortPct: 100, pass: false });
    expect(delivered({ error: 'file withheld' }).pass).toBe(false);
  });

  it("draws the line where s3-noisy.js's k6 threshold does", () => {
    for (const expected of [20, 157, 600, 6000, 150000]) {
      const min = PACE.minSteadySent!(expected);
      expect(delivered(counters(expected, min)).pass).toBe(true);
      expect(delivered(counters(expected, min - 1)).pass).toBe(false);
    }
  });
});
