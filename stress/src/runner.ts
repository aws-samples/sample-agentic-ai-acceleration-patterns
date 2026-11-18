// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Draw, type Limits, overdraws, parseDraws, sumDraws } from './budget';
import { parseRecord, recordFailures, renderResults, type ResultRecord } from './result';
import { loadSlice, orderSlices, type Slice, type Verb } from './slice';
import { tierOf, tierProblems } from './tiers';

/**
 * The runner (spec §3.5). It checks the tier and the slices, adds up the
 * quota budget, then runs each slice's verbs in dependency order, and tears
 * down in reverse order whatever happened in between.
 */

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** Runs `slice.sh <args>`. `capture` returns stdout instead of streaming it. */
export type Exec = (script: string, args: readonly string[], env: NodeJS.ProcessEnv, capture: boolean) => ExecResult;

export const spawnExec: Exec = (script, args, env, capture) => {
  const r = spawnSync('bash', [script, ...args], {
    cwd: path.dirname(script),
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '' };
};

export interface RunOptions {
  readonly repoRoot: string;
  readonly tier: string;
  readonly slices: readonly string[];
  /** Scenario ids to run; default every scenario the slices declare, in slice order. */
  readonly scenarios?: readonly string[];
  /** Folder for manifests, the lock and results, outside the repository (spec §4.2). */
  readonly home: string;
  readonly prefix: string;
  readonly runId: string;
  readonly commit: string;
  readonly limits?: Limits;
  /** Pass `--fixtures` to every `teardown` (stress ADR-0004 keeps them by default). */
  readonly removeFixtures?: boolean;
  readonly exec?: Exec;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

export interface RunSummary {
  readonly runId: string;
  readonly mode: 'slice' | 'platform';
  readonly order: readonly string[];
  readonly failures: readonly string[];
  readonly resultsFile: string;
}

/** Checks a run without running anything: the tier, the slices and their order. */
export function planRun(opts: Pick<RunOptions, 'repoRoot' | 'tier' | 'slices'>): { slices: Slice[]; mode: 'slice' | 'platform' } {
  const tier = tierOf(opts.tier);
  const problems = tierProblems(tier);
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (opts.slices.length === 0) throw new Error('name at least one slice');
  const slices = orderSlices(opts.slices.map((s) => loadSlice(opts.repoRoot, s)));
  return { slices, mode: slices.length === 1 ? 'slice' : 'platform' };
}

export function runStress(opts: RunOptions): RunSummary {
  const exec = opts.exec ?? spawnExec;
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = opts.now ?? (() => new Date());
  const { slices, mode } = planRun(opts);
  const runDir = path.join(opts.home, opts.prefix, opts.runId);
  const resultsDir = path.join(runDir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  // One run per prefix at a time (spec §3.5 step 2).
  const lock = path.join(opts.home, opts.prefix, 'run.lock');
  let lockFd: number;
  try {
    lockFd = fs.openSync(lock, 'wx');
  } catch {
    throw new Error(`another run holds ${lock}; remove it only if no run is active`);
  }
  fs.writeSync(lockFd, `${opts.runId} ${process.pid}\n`);
  fs.closeSync(lockFd);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STRESS_TIER: opts.tier,
    STRESS_RUN_ID: opts.runId,
    STRESS_PREFIX: opts.prefix,
    STRESS_HOME: opts.home,
    STRESS_MODE: mode,
    STRESS_RESULTS: resultsDir,
    STRESS_REPO: opts.repoRoot,
    STRESS_COMMIT: opts.commit,
  };
  const failures: string[] = [];
  const started = new Map<string, { start: string; deploySeconds?: number }>();
  let aborted = false;
  const onSignal = (): void => {
    aborted = true;
    log('signal received: finishing the current step, then tearing down');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const verb = (s: Slice, v: Verb, extra: readonly string[] = []): boolean => {
    log(`== ${s.name} ${v}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}`);
    const r = exec(s.script, [v, ...extra], env, false);
    if (r.status !== 0) {
      failures.push(`${s.name} ${v}${extra.length > 0 ? ` ${extra[0]}` : ''} exited ${String(r.status)}`);
      return false;
    }
    return true;
  };

  try {
    // Budget first: nothing is deployed when a sum is over a limit.
    const draws: Draw[] = [];
    for (const s of slices) {
      const r = exec(s.script, ['budget'], env, true);
      if (r.status !== 0) throw new Error(`${s.name} budget exited ${String(r.status)}`);
      const own = parseDraws(s.name, r.stdout);
      const undeclared = own.filter((d) => !s.quotas.includes(d.quota));
      if (undeclared.length > 0) {
        throw new Error(`${s.name} draws on undeclared quotas: ${[...new Set(undeclared.map((d) => d.quota))].join(', ')}`);
      }
      draws.push(...own);
    }
    const over = overdraws(sumDraws(draws), opts.limits);
    if (over.length > 0) {
      throw new Error(`budget over the limit: ${over.map((o) => `${o.account} ${o.quota} ${o.sum} > ${o.limit}`).join('; ')}`);
    }

    for (const s of slices) {
      if (aborted) break;
      const t0 = Date.now();
      started.set(s.name, { start: now().toISOString() });
      if (!verb(s, 'deploy')) throw new Error(`${s.name} deploy failed`);
      started.get(s.name)!.deploySeconds = Math.round((Date.now() - t0) / 1000);
    }
    for (const s of slices) {
      if (aborted) break;
      if (!verb(s, 'seed')) throw new Error(`${s.name} seed failed`);
    }
    const scenarios = opts.scenarios ?? [...new Set(slices.flatMap((s) => s.scenarios))];
    const unknown = scenarios.filter((sc) => !slices.some((s) => s.scenarios.includes(sc)));
    if (unknown.length > 0) throw new Error(`no slice in the run declares ${unknown.join(', ')}`);
    for (const sc of scenarios) {
      for (const s of slices.filter((x) => x.scenarios.includes(sc))) {
        if (aborted) break;
        verb(s, 'run', [sc]);
      }
    }
    for (const s of slices) {
      if (aborted) break;
      verb(s, 'collect');
    }
  } catch (e) {
    failures.push((e as Error).message);
  } finally {
    // Reverse order, every slice that started a deploy, also on failure.
    for (const s of [...slices].reverse().filter((x) => started.has(x.name))) {
      const t0 = Date.now();
      const ok = verb(s, 'teardown', opts.removeFixtures ? ['--fixtures'] : []);
      const info = started.get(s.name)!;
      const lifecycle: ResultRecord = {
        runId: opts.runId,
        tier: tierOf(opts.tier).name,
        slice: s.name,
        scenario: 'lifecycle',
        mode,
        commits: { [s.name]: opts.commit },
        window: { start: info.start, end: now().toISOString() },
        ...(info.deploySeconds === undefined ? {} : { deploySeconds: info.deploySeconds }),
        ...(ok ? { destroySeconds: Math.round((Date.now() - t0) / 1000) } : {}),
        requests: {},
        latency: {},
        isolation: { assertions: 0, mismatches: 0 },
        quotas: {},
        refusals: { byTenantReason: [], unattributed: 0 },
      };
      fs.writeFileSync(path.join(resultsDir, `${s.name}.lifecycle.json`), `${JSON.stringify(lifecycle, null, 2)}\n`);
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    fs.rmSync(lock, { force: true });
  }

  const records = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseRecord(fs.readFileSync(path.join(resultsDir, f), 'utf8'), f));
  for (const r of records) failures.push(...recordFailures(r));
  const resultsFile = path.join(runDir, 'results.md');
  if (records.length > 0) fs.writeFileSync(resultsFile, renderResults(records));
  if (aborted) failures.push('the run was interrupted');
  return { runId: opts.runId, mode, order: slices.map((s) => s.name), failures, resultsFile };
}
