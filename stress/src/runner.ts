// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Draw, type Limits, overdraws, parseDraws, sumDraws } from './budget';
import { parseRecord, recordFailures, renderResults, type ResultRecord } from './result';
import { loadSlice, orderSlices, type Slice, type Verb } from './slice';
import { type Tier, tierOf, tierProblems } from './tiers';

/**
 * The runner (spec §3.5). It checks the tier and the slices, adds up the
 * quota budget, runs each slice's verbs in dependency order, and tears down
 * in reverse order whatever happened in between, also after a failure or a
 * SIGINT, SIGTERM or SIGHUP.
 */

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** Sends a signal to everything a running verb started. */
export type Stop = (signal: NodeJS.Signals) => void;

/**
 * Runs `slice.sh <args>`. `capture` returns stdout instead of streaming it.
 * `onStart` hands the runner a `Stop` while the verb runs, and `undefined`
 * once it has ended.
 */
export type Exec = (
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  capture: boolean,
  onStart: (stop: Stop | undefined) => void,
) => Promise<ExecResult>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a process group still has a live member. On Linux it reads
 * `/proc`, so zombies (state Z) waiting for a pid 1 that does not reap
 * them do not count; elsewhere it asks the kernel, which counts them.
 */
function groupAlive(pgid: number): boolean {
  if (fs.existsSync('/proc/self/stat')) {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      } catch {
        continue;
      }
      // pid (comm) state ppid pgrp ...; comm may hold spaces and parentheses.
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(pgrp) === pgid && state !== 'Z') return true;
    }
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Stops what is left of a process group: SIGTERM, then SIGKILL after `graceMs`. */
async function reapGroup(pgid: number, graceMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(100);
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, 'SIGKILL');
  const hard = Date.now() + 5000;
  while (groupAlive(pgid) && Date.now() < hard) await sleep(100);
}

/**
 * An `Exec` that runs each verb in its own session and process group, so a
 * signal reaches `slice.sh` and everything it started (`cdk`, `aws`, `k6`),
 * and a terminal Ctrl-C or hangup reaches only the runner. When `slice.sh` exits, anything
 * it left running in its group is stopped before the verb counts as done,
 * with `graceMs` between SIGTERM and SIGKILL. Verbs get no stdin.
 */
export function groupExec(graceMs = 30_000): Exec {
  return (script, args, env, capture, onStart) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', [script, ...args], {
        cwd: path.dirname(script),
        env,
        detached: true,
        stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      });
      const pgid = child.pid;
      let stdout = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      let status: number | null = null;
      const closed = new Promise<void>((r) => child.on('close', () => r()));
      child.on('error', (e) => {
        onStart(undefined);
        reject(e);
      });
      if (pgid === undefined) return;
      onStart((signal) => signalGroup(pgid, signal));
      child.on('exit', (code) => {
        status = code;
        void reapGroup(pgid, graceMs)
          .then(() => closed)
          .then(() => {
            onStart(undefined);
            resolve({ status, stdout });
          });
      });
    });
}

export const spawnExec: Exec = groupExec();

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
  /** Where SIGINT, SIGTERM and SIGHUP come from; default `process`. */
  readonly signals?: Pick<NodeJS.EventEmitter, 'on' | 'off'>;
}

export interface RunSummary {
  readonly runId: string;
  readonly mode: 'slice' | 'platform';
  readonly order: readonly string[];
  readonly failures: readonly string[];
  /** The signal that interrupted the run, if one did. */
  readonly signal?: NodeJS.Signals;
  /** Undefined when no record could be rendered. */
  readonly resultsFile?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The signals that stop a run and start teardown. */
const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Logs to stderr; a write to a terminal that hung up must not stop teardown. */
function logToStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr is gone (EIO after a hangup); keep going.
  }
}
const ignore = (): void => undefined;

const hashOf = (file: string): string | undefined =>
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : undefined;

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

/**
 * The environment `budget` runs in (spec §3.4: without credentials): no
 * `AWS_*` variable from the runner, an empty `HOME` so no shared config or
 * credentials file is found, and the EC2 instance metadata lookup disabled.
 */
function budgetEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('AWS_'))),
    HOME: home,
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

export async function runStress(opts: RunOptions): Promise<RunSummary> {
  const exec = opts.exec ?? spawnExec;
  const log = opts.log ?? logToStderr;
  const now = opts.now ?? (() => new Date());
  const signals = opts.signals ?? process;
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
  const ran: Ran[] = [];
  let signal: NodeJS.Signals | undefined;
  let tearingDown = false;
  let stop: Stop | undefined;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (tearingDown) {
      log(`${sig}: ignored, teardown is running`);
      return;
    }
    if (signal === undefined) log(`${sig}: stopping the current step, then tearing down`);
    signal ??= sig;
    stop?.(sig);
  };
  const track = (s: Stop | undefined): void => {
    stop = s;
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
    if (signal !== undefined) throw new Error(`the run was interrupted (${signal})`);
  };

  for (const sig of SIGNALS) signals.on(sig, onSignal);
  process.stderr.on('error', ignore);
  try {
    fs.mkdirSync(resultsDir, { recursive: true });

    // Budget first: nothing is deployed when a sum is over a limit.
    const draws: Draw[] = [];
    for (const s of slices) {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-budget-'));
      let r: ExecResult;
      try {
        r = await exec(s.script, ['budget'], budgetEnv(env, emptyHome), true, track);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
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
        const ok = await verb(s, 'run', [sc]);
        ran.push({ slice: s.name, scenario: sc, ok, hash: hashOf(path.join(resultsDir, `${s.name}.${sc}.json`)) });
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
    // Reverse order, every slice that started a deploy, also on failure or a
    // signal. Signals during teardown are logged, not forwarded, and one
    // slice's teardown error does not skip the others.
    tearingDown = true;
    try {
      for (const s of [...slices].reverse().filter((x) => started.has(x.name))) {
        try {
          await teardown(s);
        } catch (e) {
          failures.push(`${s.name} teardown: ${(e as Error).message}`);
        }
      }
    } finally {
      for (const sig of SIGNALS) signals.off(sig, onSignal);
      process.stderr.off('error', ignore);
      fs.rmSync(lock, { force: true });
    }
  }
  if (signal !== undefined && !failures.some((f) => f.startsWith('the run was interrupted'))) {
    failures.push(`the run was interrupted (${signal})`);
  }

  const records = checkRecords(resultsDir, { runId: opts.runId, tier: tier.name, mode }, slices, ran, failures);
  let resultsFile: string | undefined;
  if (records.length > 0) {
    resultsFile = path.join(runDir, 'results.md');
    fs.writeFileSync(resultsFile, renderResults(records));
  }
  return { runId: opts.runId, mode, order: slices.map((s) => s.name), failures, ...(signal === undefined ? {} : { signal }), resultsFile };

  async function teardown(s: Slice): Promise<void> {
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
}

/** A scenario a slice ran: whether `run` exited 0, and the hash of its record when `run` returned. */
interface Ran {
  readonly slice: string;
  readonly scenario: string;
  readonly ok: boolean;
  readonly hash?: string;
}

/**
 * Reads the run's records and adds a failure for each problem: a record
 * that does not parse, does not belong to the run, or is for a slice or
 * scenario the run did not run; a `run` that exited 0 but wrote no record;
 * a scenario record with no isolation assertion (P-1); and the pass
 * criteria of each record (spec §7).
 */
function checkRecords(
  dir: string,
  run: Pick<ResultRecord, 'runId' | 'tier' | 'mode'>,
  slices: readonly Slice[],
  ran: readonly Ran[],
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
    if (!slices.some((s) => s.name === r.slice)) {wrong.push('slice');} else if (r.scenario !== 'lifecycle') {
      const own = ran.find((x) => x.slice === r.slice && x.scenario === r.scenario);
      if (own === undefined) wrong.push('scenario not run');
      else if (own.hash !== hashOf(path.join(dir, f))) wrong.push('changed after its run');
    }
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
  for (const e of ran.filter((x) => x.ok)) {
    if (!records.some((r) => r.slice === e.slice && r.scenario === e.scenario)) {
      failures.push(`${e.slice} run ${e.scenario} exited 0 but wrote no valid ${e.slice}.${e.scenario}.json`);
    }
  }
  return records;
}
