// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { record } from './result.test';
import type { Exec } from '../src/runner';
import { planRun, runStress } from '../src/runner';

/** A repository with fake slices; the exec stub records calls and writes results. */
function fixture(slices: Record<string, { needs?: string[]; scenarios: string[]; quotas?: string[] }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  for (const [name, d] of Object.entries(slices)) {
    const dir = path.join(root, 'samples', name, 'scripts', 'stress');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'slice.json'), JSON.stringify({ name, ...d }));
    fs.writeFileSync(path.join(dir, 'slice.sh'), '');
  }
  return { root, home: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')) };
}

function stub(opts: { budgets?: Record<string, object>; fail?: string; mismatch?: string } = {}) {
  const calls: string[] = [];
  const exec: Exec = (script, args, env) => {
    const slice = script.split(path.sep).slice(-4)[0];
    calls.push(`${slice} ${args.join(' ')}`);
    if (args[0] === 'budget') return { status: 0, stdout: JSON.stringify(opts.budgets?.[slice] ?? { draws: [] }) };
    if (`${slice} ${args[0]}` === opts.fail) return { status: 1, stdout: '' };
    if (args[0] === 'run') {
      const mismatch = opts.mismatch === slice ? { isolation: { assertions: 5, mismatches: 1 } } : {};
      const r = record({ slice, scenario: args[1], runId: env.STRESS_RUN_ID!, ...mismatch });
      fs.writeFileSync(path.join(env.STRESS_RESULTS!, `${slice}.${args[1]}.json`), JSON.stringify(r));
    }
    return { status: 0, stdout: '' };
  };
  return { calls, exec };
}

const base = { runId: '20261118T150000Z', commit: 'f368ad5', prefix: 'stress', log: () => undefined };

describe('runner (spec §3.5)', () => {
  const slices = {
    'tenant-identity': { scenarios: ['PS-1'], quotas: ['cognito-groups'] },
    'control-plane': { needs: ['tenant-identity'], scenarios: ['PS-1', 'PS-5'], quotas: ['codebuild-linux-small'] },
  };

  it('plans the order and the mode', () => {
    const { root } = fixture(slices);
    const plan = planRun({ repoRoot: root, tier: 'small', slices: ['control-plane', 'tenant-identity'] });
    expect(plan.mode).toBe('platform');
    expect(plan.slices.map((s) => s.name)).toEqual(['tenant-identity', 'control-plane']);
    expect(planRun({ repoRoot: root, tier: 'small', slices: ['control-plane'] }).mode).toBe('slice');
  });

  it('runs every verb in dependency order and tears down in reverse', () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub();
    const summary = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['control-plane', 'tenant-identity'], exec });
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
      'tenant-identity collect',
      'control-plane collect',
      'control-plane teardown',
      'tenant-identity teardown',
    ]);
    expect(summary.failures).toEqual([]);
    const md = fs.readFileSync(summary.resultsFile, 'utf8');
    expect(md).toContain('| control-plane | PS-5 |');
    expect(md).toContain('| tenant-identity |');
    expect(fs.existsSync(path.join(home, 'stress', 'run.lock'))).toBe(false);
  });

  it('refuses to deploy when the budget is over a limit', () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({
      budgets: { 'control-plane': { draws: [{ account: 'platform', quota: 'codebuild-linux-small', amount: 100 }] } },
    });
    const summary = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['control-plane', 'tenant-identity'], exec });
    expect(summary.failures.join()).toMatch(/platform codebuild-linux-small 100 > 1/);
    expect(calls.some((c) => c.endsWith('deploy'))).toBe(false);
    const ok = stub({ budgets: { 'control-plane': { draws: [{ account: 'platform', quota: 'codebuild-linux-small', amount: 100 }] } } });
    const passed = runStress({ ...base, runId: 'r2', repoRoot: root, home, tier: 'small', slices: ['control-plane', 'tenant-identity'], exec: ok.exec, limits: { platform: { 'codebuild-linux-small': 300 } } });
    expect(passed.failures).toEqual([]);
  });

  it('refuses a draw on a quota the slice did not declare', () => {
    const { root, home } = fixture(slices);
    const { exec } = stub({ budgets: { 'tenant-identity': { draws: [{ account: 'platform', quota: 'kms-rsa-rps', amount: 1 }] } } });
    const summary = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec });
    expect(summary.failures.join()).toMatch(/undeclared quotas: kms-rsa-rps/);
  });

  it('tears down every slice that started when a deploy fails, and only those', () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({ fail: 'control-plane deploy' });
    const summary = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['control-plane', 'tenant-identity'], exec });
    expect(calls.filter((c) => c.endsWith('teardown'))).toEqual(['control-plane teardown', 'tenant-identity teardown']);
    expect(calls.some((c) => c.includes(' run '))).toBe(false);
    expect(summary.failures).toContain('control-plane deploy failed');
  });

  it('fails the run on an isolation mismatch in a record, and passes --fixtures when asked', () => {
    const { root, home } = fixture(slices);
    const { calls, exec } = stub({ mismatch: 'control-plane' });
    const summary = runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['control-plane', 'tenant-identity'], scenarios: ['PS-5'], exec, removeFixtures: true });
    expect(summary.failures).toEqual(['control-plane PS-5: 1 isolation mismatches']);
    expect(calls).toContain('control-plane teardown --fixtures');
    expect(calls.filter((c) => c.includes(' run '))).toEqual(['control-plane run PS-5']);
  });

  it('refuses a scenario no slice declares and a second run on the same prefix', () => {
    const { root, home } = fixture(slices);
    const { exec } = stub();
    expect(runStress({ ...base, repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], scenarios: ['PS-9'], exec }).failures.join()).toMatch(/declares PS-9/);
    fs.writeFileSync(path.join(home, 'stress', 'run.lock'), 'other');
    expect(() => runStress({ ...base, runId: 'r3', repoRoot: root, home, tier: 'small', slices: ['tenant-identity'], exec })).toThrow(/another run holds/);
  });
});
