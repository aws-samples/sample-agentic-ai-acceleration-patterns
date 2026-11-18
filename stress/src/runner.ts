// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Draw, type Limits, overdraws, parseDraws, sumDraws } from './budget';
import { parseRecord, recordFailures, renderResults, type ResultRecord } from './result';
import { loadSlice, orderSlices, type Slice, type Verb } from './slice';
import { type Tier, tierOf, tierProblems } from './tiers';

/**
 * The runner (spec §3.5). It checks the tier and the slices, adds up the
 * quota budget, runs each slice's verbs in dependency order, and tears down
 * in reverse order whatever happened in between, also after a failure or a
 * SIGINT or SIGTERM.
 */

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
}

/**
 * Runs `slice.sh <args>`. `capture` returns stdout instead of streaming it.
 * `onChild` hands the child to the runner, so a signal can reach it.
 */
export type Exec = (
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  capture: boolean,
  onChild: (child: ChildProcess | undefined) => void,
) => Promise<ExecResult>;

export const spawnExec: Exec = (script, args, env, capture, onChild) =>
  new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], {
      cwd: path.dirname(script),
      env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    onChild(child);
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      onChild(undefined);
      resolve({ status, stdout });
    });
  });

export interface RunOptions {
  readonly repoRoot: string;
  readonly tier: string;
  readonly slices: readonly string[];
  /** Scenario ids to run; default every scenario the slices declare (see `scenarioOrder`). */
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
  /** Undefined when no record could be rendered. */
  readonly resultsFile?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Checks a run without running anything: the tier, the slices and their order. */
export function planRun(opts: Pick<RunOptions, 'repoRoot' | 'tier' | 'slices'>): { tier: Tier; slices: Slice[]; mode: 'slice' | 'platform' } {
  const tier = tierOf(opts.tier);
  const problems = tierProblems(tier);
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (opts.slices.length === 0) throw new Error('name at least one slice');
  const slices = orderSlices(opts.slices.map((s) => loadSlice(opts.repoRoot, s)));
  return { tier, slices, mode: slices.length === 1 ? 'slice' : 'platform' };
}

/**
 * The default scenario order: the platform scenarios `PS-<n>` by number
 * (spec §5.1), then each slice's own scenarios in the order it declares them.
 */
export function scenarioOrder(slices: readonly Slice[]): string[] {
  const all = [...new Set(slices.flatMap((s) => s.scenarios))];
  const platform = all.filter((s) => /^PS-\d+$/.test(s)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  return [...platform, ...all.filter((s) => !platform.includes(s))];
}

/** The environment without AWS credentials or profiles: `budget` runs without them (spec §3.4). */
function withoutAws(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AWS_')));
}

export async function runStress(opts: RunOptions): Promise<RunSummary> {
  const exec = opts.exec ?? spawnExec;
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = opts.now ?? (() => new Date());
  if (!ID.test(opts.runId)) throw new Error(`STRESS_RUN_ID must match ${ID}`);
  if (!ID.test(opts.prefix)) throw new Error(`STRESS_PREFIX must match ${ID}`);
  const { tier, slices, mode } = planRun(opts);
  const prefixDir = path.join(opts.home, opts.prefix);
  const runDir = path.join(prefixDir, opts.runId);
  const resultsDir = path.join(runDir, 'results');
  if (fs.existsSync(runDir)) throw new Error(`${runDir} exists: use a new STRESS_RUN_ID`);

  // One run per prefix on this host. Runs from another prefix or host
  // against the same accounts are not detected (README, known limitations).
  fs.mkdirSync(prefixDir, { recursive: true });
  const lock = path.join(prefixDir, 'run.lock');
  try {
    fs.writeFileSync(lock, `${opts.runId} ${process.pid}\n`, { flag: 'wx' });
  } catch {
    throw new Error(`another run holds ${lock}; remove it only if no run is active`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STRESS_TIER: tier.name,
    STRESS_TIER_JSON: JSON.stringify(tier),
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
  const expected: { slice: string; scenario: string }[] = [];
  let aborted = false;
  let child: ChildProcess | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!aborted) log(`${signal}: stopping the current step, then tearing down`);
    aborted = true;
    child?.kill(signal);
  };
  const track = (c: ChildProcess | undefined): void => {
    child = c;
  };

  const verb = async (s: Slice, v: Verb, extra: readonly string[] = []): Promise<boolean> => {
    log(`== ${s.name} ${v}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}`);
    const r = await exec(s.script, [v, ...extra], env, false, track);
    if (r.status !== 0) {
      failures.push(`${s.name} ${v}${extra.length > 0 ? ` ${extra[0]}` : ''} exited ${String(r.status)}`);
      return false;
    }
    return true;
  };
  const stopIfAborted = (): void => {
    if (aborted) throw new Error('the run was interrupted');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    fs.mkdirSync(resultsDir, { recursive: true });

    // Budget first: nothing is deployed when a sum is over a limit.
    const draws: Draw[] = [];
    for (const s of slices) {
      const r = await exec(s.script, ['budget'], withoutAws(env), true, track);
      if (r.status !== 0) throw new Error(`${s.name} budget exited ${String(r.status)}`);
      const own = parseDraws(s.name, r.stdout, tier.cellAccounts);
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
    stopIfAborted();

    for (const s of slices) {
      const t0 = Date.now();
      started.set(s.name, { start: now().toISOString() });
      if (!(await verb(s, 'deploy'))) throw new Error(`${s.name} deploy failed`);
      started.get(s.name)!.deploySeconds = Math.round((Date.now() - t0) / 1000);
      stopIfAborted();
    }
    for (const s of slices) {
      if (!(await verb(s, 'seed'))) throw new Error(`${s.name} seed failed`);
      stopIfAborted();
    }
    const scenarios = opts.scenarios ?? scenarioOrder(slices);
    const unknown = scenarios.filter((sc) => !slices.some((s) => s.scenarios.includes(sc)));
    if (unknown.length > 0) throw new Error(`no slice in the run declares ${unknown.join(', ')}`);
    for (const sc of scenarios) {
      for (const s of slices.filter((x) => x.scenarios.includes(sc))) {
        if (await verb(s, 'run', [sc])) expected.push({ slice: s.name, scenario: sc });
        stopIfAborted();
      }
    }
    for (const s of slices) {
      await verb(s, 'collect');
      stopIfAborted();
    }
  } catch (e) {
    failures.push((e as Error).message);
  } finally {
    // Reverse order, every slice that started a deploy, also on failure or a signal.
    for (const s of [...slices].reverse().filter((x) => started.has(x.name))) {
      const t0 = Date.now();
      const ok = await verb(s, 'teardown', opts.removeFixtures ? ['--fixtures'] : []);
      const info = started.get(s.name)!;
      const lifecycle: ResultRecord = {
        runId: opts.runId,
        tier: tier.name,
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

  const records = checkRecords(resultsDir, { runId: opts.runId, tier: tier.name, mode }, expected, failures);
  let resultsFile: string | undefined;
  if (records.length > 0) {
    resultsFile = path.join(runDir, 'results.md');
    fs.writeFileSync(resultsFile, renderResults(records));
  }
  return { runId: opts.runId, mode, order: slices.map((s) => s.name), failures, resultsFile };
}

/**
 * Reads the run's records and adds a failure for each problem: a record
 * that does not parse or does not belong to the run, a `run` that exited 0
 * but wrote no record, a scenario record with no isolation assertion (P-1),
 * and the pass criteria of each record (spec §7).
 */
function checkRecords(
  dir: string,
  run: Pick<ResultRecord, 'runId' | 'tier' | 'mode'>,
  expected: readonly { slice: string; scenario: string }[],
  failures: string[],
): ResultRecord[] {
  const records: ResultRecord[] = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const f of files) {
    let r: ResultRecord;
    try {
      r = parseRecord(fs.readFileSync(path.join(dir, f), 'utf8'), f);
    } catch (e) {
      failures.push((e as Error).message);
      continue;
    }
    const wrong: string[] = (['runId', 'tier', 'mode'] as const).filter((k) => r[k] !== run[k]);
    if (f !== `${r.slice}.${r.scenario}.json`) wrong.push('file name');
    if (wrong.length > 0) {
      failures.push(`${f}: does not belong to this run (${wrong.join(', ')})`);
      continue;
    }
    if (r.scenario !== 'lifecycle' && r.isolation.assertions === 0) {
      failures.push(`${f}: no isolation assertion (P-1)`);
    }
    failures.push(...recordFailures(r));
    records.push(r);
  }
  for (const e of expected) {
    if (!records.some((r) => r.slice === e.slice && r.scenario === e.scenario)) {
      failures.push(`${e.slice} run ${e.scenario} exited 0 but wrote no valid ${e.slice}.${e.scenario}.json`);
    }
  }
  return records;
}
