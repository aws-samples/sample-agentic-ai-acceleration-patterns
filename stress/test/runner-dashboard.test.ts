// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { record } from './result.test';
import { type Datum, Emitter } from '../src/metrics';
import { type Exec, runStress } from '../src/runner';

/** One slice, `a`, with two scenarios, and a home folder. */
function fixture(): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const dir = path.join(root, 'samples', 'a', 'scripts', 'stress');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'slice.json'), JSON.stringify({ name: 'a', scenarios: ['PS-2', 'PS-5'], quotas: ['lambda-concurrency'] }));
  fs.writeFileSync(path.join(dir, 'slice.sh'), '');
  return { root, home: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')) };
}

interface Options {
  /** Dashboard verbs that exit 1. */
  failDashboard?: string[];
  unattributed?: number;
}

/** An exec stub: slice verbs write records, dashboard verbs are recorded with the env they saw. */
function stub(o: Options = {}) {
  const calls: string[] = [];
  const planSeen: string[] = [];
  const exec: Exec = async (script, args, env) => {
    if (script.endsWith('dashboard.sh')) {
      calls.push(`dashboard ${args[0]}`);
      if (args[0] === 'up') planSeen.push(fs.readFileSync(env.STRESS_DASHBOARD_PLAN_FILE!, 'utf8'));
      return { status: o.failDashboard?.includes(args[0]!) ? 1 : 0, stdout: '' };
    }
    calls.push(`a ${args.join(' ')}`);
    if (args[0] === 'budget') return { status: 0, stdout: JSON.stringify({ draws: [{ account: 'platform', quota: 'lambda-concurrency', amount: 40 }] }) };
    if (args[0] === 'run') {
      const r = record({ slice: 'a', scenario: args[1], runId: env.STRESS_RUN_ID!, mode: env.STRESS_MODE as 'slice' | 'platform', isolation: { assertions: 7, mismatches: 0 } });
      fs.writeFileSync(path.join(env.STRESS_RESULTS!, `a.${args[1]}.json`), JSON.stringify(r));
    }
    return { status: 0, stdout: '' };
  };
  return { calls, planSeen, exec };
}

function emitter() {
  const sent: Datum[] = [];
  const e = new Emitter(async (d) => void sent.push(...d), 'r1');
  return { sent, e };
}

const base = { runId: 'r1', commit: 'f368ad5', prefix: 'Stress', tier: 'small', slices: ['a'], log: () => undefined };

describe('the runner and the dashboard (stress ADR-0022)', () => {
  it('deploys the dashboard after budget and before the first deploy, and removes it after the last teardown', async () => {
    const { root, home } = fixture();
    const { calls, exec } = stub();
    const { e } = emitter();
    const summary = await runStress({ ...base, repoRoot: root, home, exec, metrics: e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    expect(summary.failures).toEqual([]);
    expect(calls).toEqual(['a budget', 'dashboard up', 'a deploy', 'a seed', 'a run PS-2', 'a run PS-5', 'a collect', 'a teardown', 'dashboard snapshot', 'dashboard down']);
  });

  it('writes the plan before the dashboard comes up: one run for each record and the budget\'s quota pairs', async () => {
    const { root, home } = fixture();
    const { exec, planSeen } = stub();
    await runStress({ ...base, repoRoot: root, home, exec, metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    const plan = JSON.parse(planSeen[0]!) as Record<string, unknown>;
    expect(plan).toMatchObject({ runId: 'r1', tier: 'small', commit: 'f368ad5', region: 'eu-central-1', runs: [{ slice: 'a', scenario: 'PS-2' }, { slice: 'a', scenario: 'PS-5' }], quotas: ['platform:lambda-concurrency'] });
    expect(plan.start).toBeUndefined();
    // After the run the plan holds the window a dashboard deployed again shows.
    const after = JSON.parse(fs.readFileSync(path.join(home, 'Stress', 'r1', 'dashboard-plan.json'), 'utf8')) as { start?: string; end?: string };
    expect(Date.parse(after.start!)).toBeLessThanOrEqual(Date.parse(after.end!));
  });

  it('keeps the dashboard with --keep-dashboard, still takes the snapshots, and says so', async () => {
    const { root, home } = fixture();
    const { calls, exec } = stub();
    const lines: string[] = [];
    await runStress({ ...base, repoRoot: root, home, exec, log: (l) => lines.push(l), metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: true, region: 'eu-central-1', settleMs: 0 } });
    expect(calls.filter((c) => c.startsWith('dashboard'))).toEqual(['dashboard up', 'dashboard snapshot']);
    expect(lines.some((l) => l.includes('dashboard kept: Stress-run'))).toBe(true);
  });

  it('goes on without the dashboard when up fails, still runs the down, and does not fail the run', async () => {
    const { root, home } = fixture();
    const { calls, exec } = stub({ failDashboard: ['up'] });
    const summary = await runStress({ ...base, repoRoot: root, home, exec, metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    expect(summary.failures).toEqual([]);
    expect(calls.filter((c) => c.startsWith('dashboard'))).toEqual(['dashboard up', 'dashboard down']);
  });

  it('fails the run when the dashboard cannot be removed, because that is a leftover', async () => {
    const { root, home } = fixture();
    const { exec } = stub({ failDashboard: ['down'] });
    const summary = await runStress({ ...base, repoRoot: root, home, exec, metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    expect(summary.failures).toEqual([expect.stringMatching(/dashboard down exited non-zero/)]);
  });

  it('does not fail the run when a snapshot fails', async () => {
    const { root, home } = fixture();
    const { exec } = stub({ failDashboard: ['snapshot'] });
    const summary = await runStress({ ...base, repoRoot: root, home, exec, metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    expect(summary.failures).toEqual([]);
  });

  it('writes a lifecycle record for the dashboard, and the results file names its window and link', async () => {
    const { root, home } = fixture();
    const { exec } = stub();
    const summary = await runStress({ ...base, repoRoot: root, home, exec, metrics: emitter().e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    const text = fs.readFileSync(summary.resultsFile!, 'utf8');
    expect(text).toMatch(/\| dashboard \| \d+ \| \d+ \|/);
    expect(text).toContain('[Stress-run](https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards/dashboard/Stress-run)');
    expect(text).toMatch(/- Dashboard window PS-2 \(a\): \d{4}-.*Z to \d{4}-.*Z \(UTC\)/);
    expect(text).not.toMatch(/\d{12}/);
  });

  it('publishes the scenario strip, the isolation finals, the lifecycle seconds and the quota plan', async () => {
    const { root, home } = fixture();
    const { exec } = stub();
    const { sent, e } = emitter();
    await runStress({ ...base, repoRoot: root, home, exec, metrics: e, dashboard: { script: '/x/dashboard.sh', keep: false, region: 'eu-central-1', settleMs: 0 } });
    const of = (name: string): Datum[] => sent.filter((d) => d.name === name);
    expect(of('ScenarioActive').map((d) => `${d.dimensions.Scenario}=${d.value}`)).toEqual(['PS-2=1', 'PS-2=0', 'PS-5=1', 'PS-5=0']);
    expect(of('IsolationAssertionsFinal').map((d) => [d.dimensions.Scenario, d.value])).toEqual([['PS-2', 7], ['PS-5', 7]]);
    expect(of('IsolationMismatchesFinal').map((d) => d.value)).toEqual([0, 0]);
    expect(of('QuotaPlannedDraw').map((d) => d.value)).toContain(40);
    expect(of('QuotaLimit').map((d) => d.value)).toContain(1000);
    const life = of('LifecycleSeconds').map((d) => `${d.dimensions.Slice}:${d.dimensions.Phase}`);
    expect(life).toEqual(expect.arrayContaining(['dashboard:deploy', 'a:deploy', 'a:destroy', 'dashboard:destroy']));
    // The unattributed count is for the k6 scenarios only: PS-5 is not one.
    expect(of('RefusalsUnattributed').map((d) => d.dimensions.Scenario)).toEqual(['PS-2']);
  });

  it('keeps a run without a dashboard or metrics exactly as it was, and tells the verbs the metrics are on only when they are', async () => {
    const { root, home } = fixture();
    const { calls, exec } = stub();
    const seen: (string | undefined)[] = [];
    const wrapped: Exec = async (script, args, env, capture, onStart, output) => {
      seen.push(env.STRESS_METRICS);
      return exec(script, args, env, capture, onStart, output);
    };
    await runStress({ ...base, repoRoot: root, home, exec: wrapped });
    expect(calls.some((c) => c.startsWith('dashboard'))).toBe(false);
    expect(new Set(seen)).toEqual(new Set([undefined]));
    const on = fixture();
    const seenOn: (string | undefined)[] = [];
    const wrappedOn: Exec = async (script, args, env, capture, onStart, output) => {
      seenOn.push(env.STRESS_METRICS);
      return exec(script, args, env, capture, onStart, output);
    };
    await runStress({ ...base, runId: 'r2', repoRoot: on.root, home: on.home, exec: wrappedOn, metrics: emitter().e });
    expect(new Set(seenOn)).toEqual(new Set(['1']));
  });
});
