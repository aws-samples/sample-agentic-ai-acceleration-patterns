// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { record } from './result.test';
import { type Exec, groupExec, planRun, runStress, scenarioOrder, spawnExec } from '../src/runner';
import { loadSlice } from '../src/slice';

type Decl = { needs?: string[]; scenarios: string[]; quotas?: string[] };

/** A repository with fake slices, and a home folder for the run. */
function fixture(slices: Record<string, Decl>, scripts: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  for (const [name, d] of Object.entries(slices)) {
    const dir = path.join(root, 'samples', name, 'scripts', 'stress');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'slice.json'), JSON.stringify({ name, ...d }));
    fs.writeFileSync(path.join(dir, 'slice.sh'), scripts[name] ?? '');
  }
  return { root, home: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')) };
}

interface StubOptions {
  budgets?: Record<string, object>;
  /** `<slice> <verb>` that exits 1. */
  fail?: string[];
  /** Slices whose run records hold one mismatch. */
  mismatch?: string[];
  /** Slices whose run writes no record. */
  silent?: string[];
  /** Slices whose run writes a record that does not parse. */
  garbage?: string[];
  /** `<slice> <verb> [<scenario>]` that sends the runner a SIGTERM. */
  signal?: string;
}

/** An exec stub: records calls and the env it saw, writes run records like a slice would. */
function stub(o: StubOptions = {}) {
  const calls: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const exec: Exec = async (script, args, env) => {
    const slice = script.split(path.sep).slice(-4)[0];
    const call = `${slice} ${args.join(' ')}`;
    calls.push(call);
    envs.push(env);
    if (call === o.signal) process.emit('SIGTERM', 'SIGTERM');
    if (o.fail?.includes(`${slice} ${args[0]}`)) return { status: 1, stdout: '' };
    if (args[0] === 'budget') return { status: 0, stdout: JSON.stringify(o.budgets?.[slice] ?? { draws: [] }) };
    if (args[0] === 'run' && !o.silent?.includes(slice)) {
      const file = path.join(env.STRESS_RESULTS!, `${slice}.${args[1]}.json`);
      if (o.garbage?.includes(slice)) {
        fs.writeFileSync(file, '{');
      } else {
        const mismatch = o.mismatch?.includes(slice) ? { isolation: { assertions: 5, mismatches: 1 } } : {};
        fs.writeFileSync(file, JSON.stringify(record({ slice, scenario: args[1], runId: env.STRESS_RUN_ID!, mode: env.STRESS_MODE as 'slice' | 'platform', ...mismatch })));
      }
    }
    return { status: 0, stdout: '' };
  };
  return { calls, envs, exec };
}

const base = { runId: '20261118T150000Z', commit: 'f368ad5', prefix: 'stress', log: () => undefined };
const slices: Record<string, Decl> = {
  'tenant-identity': { scenarios: ['PS-1'], quotas: ['cognito-groups'] },
  'control-plane': { needs: ['tenant-identity'], scenarios: ['PS-5', 'placement-race', 'PS-1'], quotas: ['codebuild-linux-small'] },
};
const both = ['control-plane', 'tenant-identity'];

describe('runner (spec §3.5)', () => {
  it('plans the order and the mode', () => {
    const { root } = fixture(slices);
    const plan = planRun({ repoRoot: root, tier: 'small', slices: both });
    expect(plan.mode).toBe('platform');
    expect(plan.slices.map((s) => s.name)).toEqual(['tenant-identity', 'control-plane']);
    expect(planRun({ repoRoot: root, tier: 'small', slices: ['control-plane'] }).mode).toBe('slice');
    expect(() => planRun({ repoRoot: root, tier: 'small', slices: [] })).toThrow(/at least one/);
  });

  it('orders platform scenarios by number, then the slices own scenarios', () => {
    const { root } = fixture(slices);
    const loaded = ['tenant-identity', 'control-plane'].map((n) => loadSlice(root, n));
    expect(scenarioOrder(loaded)).toEqual(['PS-1', 'PS-5', 'placement-race']);
  });

  it('runs every verb in dependency order and tears down in reverse', async () => {
    const { root, home } = fixture(slices);
    const { calls, envs, exec } = stub();
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec });
    expect(calls).toEqual([
      'tenant-identity budget',
      'control-plane budget',
      'tenant-identity deploy',
      'control-plane deploy',
      'tenant-identity seed',
      'control-plane seed',
      'tenant-identity run PS-1',
      'control-plane run PS-1',
      'control-plane run PS-5',
      'control-plane run placement-race',
      'tenant-identity collect',
      'control-plane collect',
      'control-plane teardown',
      'tenant-identity teardown',
    ]);
    expect(summary.failures).toEqual([]);
    expect(JSON.parse(envs[2].STRESS_TIER_JSON!).maxTenants).toBe(25);
    const md = fs.readFileSync(summary.resultsFile!, 'utf8');
    expect(md).toContain('| control-plane | PS-5 |');
    expect(md).toMatch(/\| tenant-identity \| \d+ \| \d+ \|/);
    expect(fs.existsSync(path.join(home, 'stress', 'run.lock'))).toBe(false);
  });

  it('gives budget no AWS credentials', async () => {
    const { root, home } = fixture(slices);
    const { envs, exec } = stub();
    process.env.AWS_PROFILE = 'unit-test';
    try {
      await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec });
    } finally {
      delete process.env.AWS_PROFILE;
    }
    expect(envs[0].AWS_PROFILE).toBeUndefined();
    expect(envs[0].AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(envs[0].HOME).not.toBe(process.env.HOME);
    expect(fs.existsSync(envs[0].HOME!)).toBe(false);
    expect(envs[1].AWS_PROFILE).toBe('unit-test');
    expect(envs[1].HOME).toBe(process.env.HOME);
  });

  it('refuses to deploy when the budget is over a limit, and runs with the account limits', async () => {
    const { root, home } = fixture(slices);
    const budgets = { 'control-plane': { draws: [{ account: 'platform', quota: 'codebuild-linux-small', amount: 100 }] } };
    const refused = stub({ budgets });
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec: refused.exec });
    expect(summary.failures.join()).toMatch(/platform codebuild-linux-small 100 > 1/);
    expect(refused.calls.some((c) => c.endsWith('deploy'))).toBe(false);
    const ok = stub({ budgets });
    const passed = await runStress({ ...base, runId: 'r2', repoRoot: root, home, tier: 'small', slices: both, exec: ok.exec, limits: { platform: { 'codebuild-linux-small': 300 } } });
    expect(passed.failures).toEqual([]);
  });

  it('refuses a draw on an undeclared quota, on a cell account beyond the tier, and a failed budget', async () => {
    const { root, home } = fixture(slices);
    const one = await runStress({
      ...base,
      repoRoot: root,
      home,
      tier: 'small',
      slices: ['tenant-identity'],
      exec: stub({ budgets: { 'tenant-identity': { draws: [{ account: 'platform', quota: 'kms-rsa-rps', amount: 1 }] } } }).exec,
    });
    expect(one.failures.join()).toMatch(/undeclared quotas: kms-rsa-rps/);
    const two = await runStress({
      ...base,
      runId: 'r2',
      repoRoot: root,
      home,
      tier: 'small',
      slices: ['tenant-identity'],
      exec: stub({ budgets: { 'tenant-identity': { draws: [{ account: 'cell-account-2', quota: 'cognito-groups', amount: 1 }] } } }).exec,
    });
    expect(two.failures.join()).toMatch(/"cell-account-1".."cell-account-1"/);
    const three = await runStress({ ...base, runId: 'r3', repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec: stub({ fail: ['tenant-identity budget'] }).exec });
    expect(three.failures.join()).toMatch(/budget/);
  });

  it('tears down every slice that started when a deploy fails, and only those', async () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({ fail: ['control-plane deploy'] });
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec });
    expect(calls.filter((c) => c.endsWith('teardown'))).toEqual(['control-plane teardown', 'tenant-identity teardown']);
    expect(calls.some((c) => c.includes(' run '))).toBe(false);
    expect(summary.failures).toContain('control-plane deploy failed');
  });

  it('stops after a failed seed and records a failed teardown without destroy seconds', async () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({ fail: ['tenant-identity seed', 'tenant-identity teardown'] });
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec });
    expect(calls).not.toContain('control-plane seed');
    expect(summary.failures).toEqual(expect.arrayContaining(['tenant-identity seed failed', 'tenant-identity teardown exited 1']));
    const life = JSON.parse(fs.readFileSync(path.join(home, 'stress', base.runId, 'results', 'tenant-identity.lifecycle.json'), 'utf8'));
    expect(life.destroySeconds).toBeUndefined();
    expect(life.deploySeconds).toBeGreaterThanOrEqual(0);
  });

  it('stops at a SIGTERM, skips the rest and still tears down', async () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({ signal: 'control-plane run PS-1' });
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec });
    expect(calls).not.toContain('control-plane run PS-5');
    expect(calls).not.toContain('tenant-identity collect');
    expect(calls.slice(-2)).toEqual(['control-plane teardown', 'tenant-identity teardown']);
    expect(summary.failures).toContain('the run was interrupted (SIGTERM)');
    expect(summary.signal).toBe('SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('fails on a mismatch, a missing record, a record that does not parse, and passes --fixtures when asked', async () => {
    const { root, home } = fixture({ ...slices, 'tenant-front-door': { needs: ['control-plane'], scenarios: ['PS-5'] } });
    const { calls, exec } = stub({ mismatch: ['control-plane'], silent: ['tenant-front-door'] });
    const summary = await runStress({
      ...base, repoRoot: root, home, tier: 'small', slices: [...both, 'tenant-front-door'], scenarios: ['PS-5'], exec, removeFixtures: true,
    });
    expect(summary.failures).toEqual([
      'control-plane PS-5: 1 isolation mismatches',
      'tenant-front-door run PS-5 exited 0 but wrote no valid tenant-front-door.PS-5.json',
    ]);
    expect(calls).toContain('control-plane teardown --fixtures');
    const bad = await runStress({ ...base, runId: 'r2', repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec: stub({ garbage: ['tenant-identity'] }).exec });
    expect(bad.failures).toEqual(['tenant-identity.PS-1.json: not JSON', 'tenant-identity run PS-1 exited 0 but wrote no valid tenant-identity.PS-1.json']);
    expect(fs.existsSync(bad.resultsFile!)).toBe(true);
  });

  it('refuses a record of another run, of a slice or scenario not run, or with no assertion', async () => {
    const { root, home } = fixture(slices);
    const exec: Exec = async (_script, args, env) => {
      if (args[0] === 'budget') return { status: 0, stdout: '{"draws":[]}' };
      if (args[0] === 'run') {
        const runId = env.STRESS_RUN_ID!;
        const write = (r: object, f: string): void => fs.writeFileSync(path.join(env.STRESS_RESULTS!, f), JSON.stringify(r));
        write(record({ slice: 'tenant-identity', scenario: 'PS-2', runId: 'old', mode: 'slice' }), 'tenant-identity.PS-2.json');
        write(record({ slice: 'control-plane', scenario: 'PS-1', runId, mode: 'slice' }), 'control-plane.PS-1.json');
        write(record({ slice: 'tenant-identity', scenario: 'PS-1', runId, mode: 'slice', isolation: { assertions: 0, mismatches: 0 } }), 'tenant-identity.PS-1.json');
      }
      return { status: 0, stdout: '' };
    };
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec });
    expect(summary.failures).toEqual([
      'control-plane.PS-1.json: does not belong to this run (slice)',
      'tenant-identity.PS-1.json: no isolation assertion (P-1)',
      'tenant-identity.PS-2.json: does not belong to this run (runId, scenario not run)',
    ]);
  });

  it('refuses a record another slice rewrote after its run', async () => {
    const { root, home } = fixture({ 'tenant-identity': { scenarios: ['PS-1'] }, 'control-plane': { needs: ['tenant-identity'], scenarios: ['PS-1'] } });
    const { exec } = stub();
    const rewrite: Exec = async (script, args, env, capture, onStart) => {
      const r = await exec(script, args, env, capture, onStart);
      if (args[0] === 'run' && script.includes('control-plane')) {
        const f = path.join(env.STRESS_RESULTS!, 'tenant-identity.PS-1.json');
        fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), requests: { 200: 1 } }));
      }
      return r;
    };
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec: rewrite });
    expect(summary.failures).toEqual(['tenant-identity.PS-1.json: does not belong to this run (changed after its run)', 'tenant-identity run PS-1 exited 0 but wrote no valid tenant-identity.PS-1.json']);
  });

  it('keeps the record of a scenario whose run failed', async () => {
    const { root, home } = fixture({ 'tenant-identity': { scenarios: ['PS-1', 'PS-2'] } });
    const { exec } = stub({ fail: ['tenant-identity run'] });
    const writeOnFail: Exec = async (script, args, env, capture, onStart) => {
      const r = await exec(script, args, env, capture, onStart);
      if (args[0] === 'run' && args[1] === 'PS-1') {
        fs.writeFileSync(path.join(env.STRESS_RESULTS!, 'tenant-identity.PS-1.json'), JSON.stringify(record({ slice: 'tenant-identity', scenario: 'PS-1', runId: env.STRESS_RUN_ID!, mode: 'slice' })));
      }
      return r;
    };
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], scenarios: ['PS-1'], exec: writeOnFail });
    expect(summary.failures).toEqual(['tenant-identity run PS-1 exited 1']);
  });

  it('refuses an unknown scenario, a reused run id, a bad id and a second run on the same prefix', async () => {
    const { root, home } = fixture(slices);
    const { exec } = stub();
    const first = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], scenarios: ['PS-9'], exec });
    expect(first.failures.join()).toMatch(/declares PS-9/);
    await expect(runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec })).rejects.toThrow(/use a new STRESS_RUN_ID/);
    await expect(runStress({ ...base, runId: '../x', repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec })).rejects.toThrow(/STRESS_RUN_ID must match/);
    fs.writeFileSync(path.join(home, 'stress', 'run.lock'), 'other');
    await expect(runStress({ ...base, runId: 'r3', repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec })).rejects.toThrow(/another run holds/);
  });
});

/** Waits until `file` exists. */
async function until(file: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('runner with real processes', () => {
  const script = [
    'case "$1" in',
    '  budget) echo \'{"draws":[]}\' ;;',
    '  deploy) ( sleep 3; touch "$STRESS_HOME/orphan-finished" ) & touch "$STRESS_HOME/deploy-started"; wait ;;',
    '  teardown) touch "$STRESS_HOME/teardown-started"; sleep 1.5; touch "$STRESS_HOME/teardown-done" ;;',
    'esac',
    '',
  ].join('\n');

  it('stops everything the interrupted verb started, and shields teardown from a second signal', async () => {
    const { root, home } = fixture({ demo: { scenarios: ['S1'] } }, { demo: script });
    const lines: string[] = [];
    const signals = new EventEmitter();
    const running = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['demo'], exec: groupExec(2000), log: (l) => lines.push(l), signals });
    await until(path.join(home, 'deploy-started'));
    signals.emit('SIGTERM', 'SIGTERM');
    await until(path.join(home, 'teardown-started'));
    signals.emit('SIGTERM', 'SIGTERM');
    const summary = await running;
    expect(fs.existsSync(path.join(home, 'teardown-done'))).toBe(true);
    expect(summary.signal).toBe('SIGTERM');
    expect(summary.failures).toEqual(expect.arrayContaining(['demo deploy exited null', 'the run was interrupted (SIGTERM)']));
    expect(lines).toContain('SIGTERM: ignored, teardown is running');
    const life = JSON.parse(fs.readFileSync(path.join(home, 'stress', base.runId, 'results', 'demo.lifecycle.json'), 'utf8'));
    expect(life.destroySeconds).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 3000));
    expect(fs.existsSync(path.join(home, 'orphan-finished'))).toBe(false);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  }, 30_000);

  it('treats a hangup like SIGTERM', async () => {
    const { root, home } = fixture({ demo: { scenarios: ['S1'] } }, { demo: script });
    const signals = new EventEmitter();
    const running = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['demo'], exec: groupExec(2000), log: () => undefined, signals });
    await until(path.join(home, 'deploy-started'));
    signals.emit('SIGHUP', 'SIGHUP');
    const summary = await running;
    expect(summary.signal).toBe('SIGHUP');
    expect(fs.existsSync(path.join(home, 'teardown-done'))).toBe(true);
    expect(signals.listenerCount('SIGHUP')).toBe(0);
  }, 30_000);

  it('tears down the others and releases the lock when one teardown throws', async () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub();
    const throwing: Exec = async (s, args, env, capture, onStart) => {
      if (args[0] === 'teardown' && s.includes('control-plane')) throw new Error('spawn bash ENOENT');
      return exec(s, args, env, capture, onStart);
    };
    const summary = await runStress({ ...base, repoRoot: root, home, tier: 'small', slices: both, exec: throwing });
    expect(summary.failures).toContain('control-plane teardown: spawn bash ENOENT');
    expect(calls).toContain('tenant-identity teardown');
    expect(fs.existsSync(path.join(home, 'stress', 'run.lock'))).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});

describe('spawnExec', () => {
  it('stops what a verb leaves running, so a captured budget does not hang', async () => {
    const { root } = fixture({ demo: { scenarios: [] } }, { demo: '( sleep 20 ) &\necho hi\n' });
    const t0 = Date.now();
    const r = await groupExec(2000)(path.join(root, 'samples', 'demo', 'scripts', 'stress', 'slice.sh'), ['budget'], process.env, true, () => undefined);
    expect(r).toEqual({ status: 0, stdout: 'hi\n' });
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  it('runs slice.sh with bash, captures stdout when asked and hands over the child', async () => {
    const { root } = fixture({ demo: { scenarios: [] } }, { demo: 'echo "$1 $STRESS_X"; exit "${2:-0}"\n' });
    const script = path.join(root, 'samples', 'demo', 'scripts', 'stress', 'slice.sh');
    const seen: unknown[] = [];
    const r = await spawnExec(script, ['budget'], { ...process.env, STRESS_X: 'y' }, true, (c) => seen.push(c));
    expect(r).toEqual({ status: 0, stdout: 'budget y\n' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeUndefined();
    expect((await spawnExec(script, ['x', '3'], process.env, true, () => undefined)).status).toBe(3);
  });
});
