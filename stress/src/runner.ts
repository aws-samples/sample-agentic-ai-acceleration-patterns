// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Draw, type Limits, overdraws, parseDraws, QUOTAS, sumDraws } from './budget';
import { dashboardName, type Emitter, K6_SCENARIOS, stampFor } from './metrics';
import { setupActions, stepsBeforeTeardown } from './platform';
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
 * once it has ended. `output` receives everything the verb prints that is
 * not captured; the verb never writes to the runner's terminal itself.
 */
export type Exec = (
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  capture: boolean,
  onStart: (stop: Stop | undefined) => void,
  output?: (chunk: string) => void,
) => Promise<ExecResult>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a process group still has a live member. On Linux it reads
 * `/proc`, so zombies (state Z) waiting for a pid 1 that does not reap
 * them do not count; elsewhere it asks the kernel, which counts them.
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
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
  return true;
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
 * with `graceMs` between SIGTERM and SIGKILL. Verbs get no stdin, and
 * their stdout and stderr are pipes to the runner, so a terminal that hung
 * up cannot fail a verb's writes.
 */
export function groupExec(graceMs = 30_000): Exec {
  return (script, args, env, capture, onStart, output = logToStderr) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', [script, ...args], {
        cwd: path.dirname(script),
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pgid = child.pid;
      let stdout = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (capture) stdout += chunk;
        else output(chunk);
      });
      child.stderr?.on('data', (chunk: string) => output(chunk));
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
  /** Scenario ids to run; default per mode (see `scenarioOrder`): the `PS-<n>` scenarios in a platform run, every scenario but the `platformOnly` ones in a slice run. */
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
  /** Publishes the run's `StressRun` metrics (stress ADR-0022); without it the run publishes none. */
  readonly metrics?: Emitter;
  /** The run's dashboard: deployed after `budget`, snapshotted and removed after the last teardown. */
  readonly dashboard?: DashboardOptions;
}

export interface DashboardOptions {
  /** `stress/dashboard/dashboard.sh`: called with `up`, `snapshot` and `down`. */
  readonly script: string;
  /** Keep the dashboard after the run (`--keep-dashboard`); the snapshots are taken anyway. */
  readonly keep: boolean;
  /** The Region of the dashboard, for the link in the results file. */
  readonly region: string;
  /** Wait before the snapshots so the last minutes have reached CloudWatch; default 150 s. */
  readonly settleMs?: number;
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

/** Writes to stderr; a write to a terminal that hung up must not stop teardown. */
function logToStderr(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // stderr is gone (EIO after a hangup); keep going.
  }
}
const ignore = (): void => undefined;

/** Ends the run after a failure `verb` has already recorded, so it is counted once. */
class Stopped extends Error {}

const hashOf = (file: string): string | undefined =>
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : undefined;

/** Checks a run without running anything: the tier, the slices and their order. */
export function planRun(opts: Pick<RunOptions, 'repoRoot' | 'tier' | 'slices'>): { tier: Tier; slices: Slice[]; mode: 'slice' | 'platform' } {
  const tier = tierOf(opts.tier);
  const problems = tierProblems(tier);
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (opts.slices.length === 0) throw new Error('name at least one slice');
  const loaded = opts.slices.map((s) => loadSlice(opts.repoRoot, s));
  // Several slices make a platform run, which needs every slice a slice needs. Say whether a
  // missing one is no slice at all or only left out of --slices.
  if (loaded.length > 1) {
    const named = new Set(loaded.map((s) => s.name));
    for (const s of loaded) {
      for (const n of s.needs.filter((x) => !named.has(x))) {
        const declared = fs.existsSync(path.join(opts.repoRoot, 'samples', n, 'scripts', 'stress', 'slice.json'));
        throw new Error(
          declared
            ? `${s.name} needs ${n}, which the run does not include: add it to --slices`
            : `${s.name} needs ${n}, which is not a slice: samples/${n}/scripts/stress/slice.json is missing`,
        );
      }
    }
  }
  const slices = orderSlices(loaded);
  const mode = slices.length === 1 ? 'slice' : 'platform';
  setupActions(slices, mode); // refuses a platform order that calls a step a slice does not declare
  return { tier, slices, mode };
}

/**
 * The default scenario order: the platform scenarios `PS-<n>` by number
 * (spec §5.1), then each slice's own scenarios in the order it declares them.
 * `mode` picks what runs when no scenario is named (spec §5.2): a platform run
 * takes only the `PS-<n>` scenarios, a slice run takes everything but the
 * scenarios a slice marks `platformOnly`.
 */
export function scenarioOrder(slices: readonly Slice[], mode: 'slice' | 'platform'): string[] {
  const platformOnly = new Set(slices.flatMap((s) => s.platformOnly));
  const all = [...new Set(slices.flatMap((s) => s.scenarios))].filter((sc) => (mode === 'platform' ? /^PS-\d+$/.test(sc) : !platformOnly.has(sc)));
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
  const show = opts.log ?? ((l: string) => logToStderr(`${l}\n`));
  const now = opts.now ?? (() => new Date());
  const signals = opts.signals ?? process;
  if (!ID.test(opts.runId)) throw new Error(`STRESS_RUN_ID must match ${ID}`);
  if (!ID.test(opts.prefix)) throw new Error(`STRESS_PREFIX must match ${ID}`);
  const { tier, slices, mode } = planRun(opts);
  // A scenario no slice declares is refused before anything touches disk,
  // so the corrected command can reuse the run id.
  const scenarios = [...new Set(opts.scenarios ?? scenarioOrder(slices, mode))];
  const unknown = scenarios.filter((sc) => !slices.some((s) => s.scenarios.includes(sc)));
  if (unknown.length > 0) throw new Error(`no slice in the run declares ${unknown.join(', ')}`);
  if (scenarios.length === 0) {
    throw new Error(
      opts.scenarios !== undefined
        ? '--scenarios names no scenario, so the run has nothing to run'
        : mode === 'platform'
          ? 'no slice in the run declares a PS-<n> scenario, so a platform run has nothing to run: name --scenarios or add the slices that own them'
          : 'the slice declares no scenario to run in slice mode (none, or only platformOnly ones), so the run has nothing to run: add the slices it needs to --slices',
    );
  }
  // A scenario that needs the other slices' interfaces has nothing to run against alone.
  const alone = scenarios.filter((sc) => mode === 'slice' && slices.some((s) => s.platformOnly.includes(sc)));
  if (alone.length > 0) throw new Error(`${alone.join(', ')} runs in platform mode only: name every slice it needs in --slices`);
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
    // A slice's `run.sh emit` publishes only when the run has its metrics on (ADR-0022).
    ...(opts.metrics === undefined ? {} : { STRESS_METRICS: '1' }),
    // The plan the dashboard is built from (written by `dashboardUp`), and where to read it again.
    ...(opts.dashboard === undefined ? {} : { STRESS_DASHBOARD_PLAN_FILE: path.join(runDir, 'dashboard-plan.json'), STRESS_RUN_DIR: runDir }),
  };
  const failures: string[] = [];
  const started = new Map<string, { start: string; deploySeconds?: number }>();
  // What each scenario's run returned (the last run when a scenario repeats),
  // and the hash of every record file as the runner last saw it from its owner.
  const ran = new Map<string, boolean>();
  const owned = new Map<string, string | undefined>();
  const runLog = path.join(runDir, 'run.log');
  const log = (l: string): void => {
    appendLog(`${l}\n`);
    show(l);
  };
  const output = (chunk: string): void => {
    appendLog(chunk);
    logToStderr(chunk);
  };
  function appendLog(text: string): void {
    try {
      fs.appendFileSync(runLog, text, { mode: 0o600 });
    } catch {
      // The run folder is gone; the terminal copy is all there is.
    }
  }
  const own = (s: { readonly name: string }, scenario: string): void => {
    const f = `${s.name}.${scenario}.json`;
    owned.set(f, hashOf(path.join(resultsDir, f)));
  };
  const metrics = opts.metrics;
  /** The record `slice.scenario` as it is on disk now, or undefined when it is missing or does not parse. */
  const recordNow = (slice: string, scenario: string): ResultRecord | undefined => {
    try {
      return parseRecord(fs.readFileSync(path.join(resultsDir, `${slice}.${scenario}.json`), 'utf8'), `${slice}.${scenario}.json`);
    } catch {
      return undefined;
    }
  };
  const timers: NodeJS.Timeout[] = [];
  /** Emits `ScenarioActive` 1 now and every 60 s until the returned function is called, which emits 0. */
  const beat = (scenario: string): (() => Promise<void>) => {
    if (metrics === undefined) return async () => undefined;
    void metrics.emit('ScenarioActive', 1, { Scenario: scenario });
    const t = setInterval(() => void metrics.emit('ScenarioActive', 1, { Scenario: scenario }), 60_000);
    t.unref();
    timers.push(t);
    return () => {
      clearInterval(t);
      return metrics.emit('ScenarioActive', 0, { Scenario: scenario });
    };
  };
  /** The run's budget sums and limits, as `QuotaPlannedDraw` and `QuotaLimit` (design §6). */
  const publishQuotas = (sums: ReturnType<typeof sumDraws>): Promise<void> => {
    if (metrics === undefined) return Promise.resolve();
    const data = [];
    for (const [account, perAccount] of sums) {
      for (const [quota, sum] of perAccount) {
        for (const [name, value] of [['QuotaPlannedDraw', sum], ['QuotaLimit', opts.limits?.[account]?.[quota] ?? QUOTAS[quota].defaultLimit]] as const) {
          const d = metrics.make(name, value, { Account: account, Quota: quota });
          if (d !== undefined) data.push(d);
        }
      }
    }
    return metrics.send(data);
  };
  /** A scenario's isolation totals, stamped at the end of its window (design §5). */
  const publishFinals = (slice: string, scenario: string): Promise<void> => {
    const r = metrics === undefined ? undefined : recordNow(slice, scenario);
    if (metrics === undefined || r === undefined) return Promise.resolve();
    const at = stampFor(new Date(r.window.end), now());
    const dims = { Slice: slice, Scenario: scenario };
    return metrics.send(
      [metrics.make('IsolationAssertionsFinal', r.isolation.assertions, dims, at), metrics.make('IsolationMismatchesFinal', r.isolation.mismatches, dims, at)].filter((d) => d !== undefined),
    );
  };
  /** The unattributed count of a k6 scenario's record, after the slice's `collect` (design §5). */
  const publishUnattributed = (slice: string, scenario: string): Promise<void> => {
    const r = metrics === undefined || !K6_SCENARIOS.includes(scenario) ? undefined : recordNow(slice, scenario);
    if (metrics === undefined || r === undefined) return Promise.resolve();
    return metrics.emit('RefusalsUnattributed', r.refusals.unattributed, { Slice: slice, Scenario: scenario }, stampFor(new Date(r.window.end), now()));
  };
  const lifecycleSeconds = (slice: string, phase: 'deploy' | 'destroy', seconds: number): Promise<void> =>
    metrics === undefined ? Promise.resolve() : metrics.emit('LifecycleSeconds', seconds, { Slice: slice, Phase: phase });
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
    const r = await exec(s.script, [v, ...extra], env, false, track, output);
    if (r.status !== 0) {
      failures.push(`${s.name} ${v}${extra.length > 0 ? ` ${extra[0]}` : ''} exited ${String(r.status)}`);
      return false;
    }
    return true;
  };
  const stopIfAborted = (): void => {
    if (signal !== undefined) throw new Error(`the run was interrupted (${signal})`);
  };

  // The dashboard (ADR-0022): a view, so a failed `up` or `snapshot` is logged and the run goes
  // on; a `down` that leaves something behind is a failure, like any leftover.
  const dashboard = opts.dashboard;
  let dashboardTried = false;
  let dashboardDeploySeconds: number | undefined;
  let dashboardStart = '';
  let planSums: ReturnType<typeof sumDraws> = new Map();
  const dashboardVerb = async (v: 'up' | 'snapshot' | 'down'): Promise<boolean> => {
    log(`== dashboard ${v}`);
    try {
      const r = await exec(dashboard!.script, [v], env, false, track, output);
      return r.status === 0;
    } catch (e) {
      // A script that cannot start is a failed step like any other: the dashboard is a view.
      log(`dashboard ${v}: ${(e as Error).message}`);
      return false;
    }
  };
  /** What the dashboard is built from: one entry for each record the run will write, and the budget's quota pairs. */
  const writePlan = (sums: ReturnType<typeof sumDraws>, window?: { start: string; end: string }): void => {
    const plan = {
      runId: opts.runId,
      tier: tier.name,
      commit: opts.commit,
      region: dashboard!.region,
      runs: scenarios.flatMap((scenario) => slices.filter((s) => s.scenarios.includes(scenario)).map((s) => ({ slice: s.name, scenario }))),
      quotas: [...sums].flatMap(([account, perAccount]) => [...perAccount.keys()].map((quota) => `${account}:${quota}`)),
      ...(window ?? {}),
    };
    fs.writeFileSync(env.STRESS_DASHBOARD_PLAN_FILE!, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  };
  const dashboardUp = async (sums: ReturnType<typeof sumDraws>): Promise<void> => {
    dashboardTried = true;
    dashboardStart = now().toISOString();
    planSums = sums;
    writePlan(sums);
    const t0 = Date.now();
    if (await dashboardVerb('up')) {
      dashboardDeploySeconds = Math.round((Date.now() - t0) / 1000);
      await lifecycleSeconds('dashboard', 'deploy', dashboardDeploySeconds);
    } else {
      log('dashboard up failed: the run goes on without it');
    }
  };
  const dashboardEnd = async (): Promise<void> => {
    if (dashboard === undefined || !dashboardTried) return;
    // The window a dashboard deployed again later shows (`run.sh dashboard up --run <id>`).
    writePlan(planSums, { start: dashboardStart, end: new Date(now().getTime() + 5 * 60_000).toISOString() });
    if (dashboardDeploySeconds !== undefined) {
      // The last minutes reach CloudWatch a little after the run; a run that was interrupted or failed has nothing to wait for.
      if (signal === undefined && failures.length === 0) await sleep(dashboard.settleMs ?? 150_000);
      if (!(await dashboardVerb('snapshot'))) log('dashboard snapshot failed: the dashboard shows the run until it is removed');
    }
    let destroySeconds: number | undefined;
    // A dashboard that did not come up is removed even with --keep-dashboard: a half-made stack would block the next run's up.
    if (dashboard.keep && dashboardDeploySeconds !== undefined) {
      log(`dashboard kept: ${dashboardName(opts.prefix)} (stress/dashboard/README.md, "Remove a kept dashboard")`);
    } else {
      const t0 = Date.now();
      if (await dashboardVerb('down')) {
        destroySeconds = Math.round((Date.now() - t0) / 1000);
        await lifecycleSeconds('dashboard', 'destroy', destroySeconds);
      } else {
        failures.push('dashboard down exited non-zero: a stack or dashboard of the run may be left (stress/dashboard/README.md)');
      }
    }
    const record: ResultRecord = {
      runId: opts.runId,
      tier: tier.name,
      slice: 'dashboard',
      scenario: 'lifecycle',
      mode,
      commits: { dashboard: opts.commit },
      window: { start: dashboardStart, end: now().toISOString() },
      ...(dashboardDeploySeconds === undefined ? {} : { deploySeconds: dashboardDeploySeconds }),
      ...(destroySeconds === undefined ? {} : { destroySeconds }),
      requests: {},
      latency: {},
      isolation: { assertions: 0, mismatches: 0 },
      quotas: {},
      refusals: { byTenantReason: [], unattributed: 0 },
    };
    fs.writeFileSync(path.join(resultsDir, 'dashboard.lifecycle.json'), `${JSON.stringify(record, null, 2)}\n`);
    own({ name: 'dashboard' }, 'lifecycle');
  };

  for (const sig of SIGNALS) signals.on(sig, onSignal);
  process.stderr.on('error', ignore);
  try {
    // Verb output lands in run.log: keep the run folder to its owner.
    fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });

    // Budget first: nothing is deployed when a sum is over a limit.
    const draws: Draw[] = [];
    for (const s of slices) {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-budget-'));
      let r: ExecResult;
      try {
        r = await exec(s.script, ['budget'], budgetEnv(env, emptyHome), true, track, output);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
      if (r.status !== 0) throw new Error(`${s.name} budget exited ${String(r.status)}`);
      const sliceDraws = parseDraws(s.name, r.stdout, tier.cellAccounts);
      const undeclared = sliceDraws.filter((d) => !s.quotas.includes(d.quota));
      if (undeclared.length > 0) {
        throw new Error(`${s.name} draws on undeclared quotas: ${[...new Set(undeclared.map((d) => d.quota))].join(', ')}`);
      }
      draws.push(...sliceDraws);
    }
    const sums = sumDraws(draws);
    const over = overdraws(sums, opts.limits);
    if (over.length > 0) {
      throw new Error(`budget over the limit: ${over.map((o) => `${o.account} ${o.quota} ${o.sum} > ${o.limit}`).join('; ')}`);
    }
    stopIfAborted();

    // The planned draw and the limits, at the start and every minute (design §6), then the
    // dashboard: after `budget` passes and before the first slice `deploy`, so it never delays one.
    if (metrics !== undefined) {
      void publishQuotas(sums);
      const t = setInterval(() => void publishQuotas(sums), 60_000);
      t.unref();
      timers.push(t);
    }
    if (opts.dashboard !== undefined) await dashboardUp(sums);
    stopIfAborted();

    // A slice-mode run deploys and then seeds each slice in turn; a platform run follows the
    // interleaved order of `PLATFORM_SETUP` (spec §3.5), so a slice can read what an earlier
    // slice made when it deploys. A slice's deploy seconds are the time of its `deploy` and
    // its set-up steps, which is the time it takes to be ready to run (P-6); `seed` is not part of it.
    const byName = new Map(slices.map((s) => [s.name, s]));
    for (const a of setupActions(slices, mode)) {
      const s = byName.get(a.slice)!;
      const t0 = Date.now();
      if (!started.has(s.name)) started.set(s.name, { start: now().toISOString() });
      if (!(await verb(s, a.verb, a.step === undefined ? [] : [a.step]))) throw new Stopped();
      if (a.verb !== 'seed') {
        const info = started.get(s.name)!;
        info.deploySeconds = (info.deploySeconds ?? 0) + Math.round((Date.now() - t0) / 1000);
        await lifecycleSeconds(s.name, 'deploy', info.deploySeconds);
      }
      stopIfAborted();
    }
    for (const sc of scenarios) {
      for (const s of slices.filter((x) => x.scenarios.includes(sc))) {
        // A record that is there before its run was written by another verb:
        // refuse it and remove it, so the hash after the run covers only
        // what this run wrote.
        const early = `${s.name}.${sc}.json`;
        if (fs.existsSync(path.join(resultsDir, early))) {
          failures.push(`${early}: written before its run`);
          fs.rmSync(path.join(resultsDir, early), { force: true });
        }
        const endBeat = beat(sc);
        try {
          ran.set(`${s.name}.${sc}`, await verb(s, 'run', [sc]));
        } finally {
          await endBeat();
        }
        own(s, sc);
        await publishFinals(s.name, sc);
        stopIfAborted();
      }
    }
    // collect may fill in its own slice's records (late refusals, cost), but
    // only records nobody else changed since its run wrote them.
    for (const s of slices) {
      const mine = [...ran.keys()].filter((k) => k.startsWith(`${s.name}.`)).map((k) => k.slice(s.name.length + 1));
      const intact = mine.filter((sc) => {
        const h = owned.get(`${s.name}.${sc}.json`);
        return h !== undefined && h === hashOf(path.join(resultsDir, `${s.name}.${sc}.json`));
      });
      await verb(s, 'collect');
      for (const sc of intact) own(s, sc);
      for (const sc of mine) await publishUnattributed(s.name, sc);
      stopIfAborted();
    }
  } catch (e) {
    if (!(e instanceof Stopped)) failures.push((e as Error).message);
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
      try {
        await dashboardEnd();
      } catch (e) {
        failures.push(`dashboard: ${(e as Error).message}`);
      }
    } finally {
      for (const t of timers) clearInterval(t);
      await metrics?.flush();
      if (metrics !== undefined && metrics.failures > 0) log(`metrics: ${metrics.failures} publish(es) failed or were dropped; the dashboard may miss points (the records are unaffected)`);
      for (const sig of SIGNALS) signals.off(sig, onSignal);
      process.stderr.off('error', ignore);
      fs.rmSync(lock, { force: true });
    }
  }
  if (signal !== undefined && !failures.some((f) => f.startsWith('the run was interrupted'))) {
    failures.push(`the run was interrupted (${signal})`);
  }

  const records = checkRecords(resultsDir, { runId: opts.runId, tier: tier.name, mode }, ran, owned, failures);
  let resultsFile: string | undefined;
  if (records.length > 0) {
    resultsFile = path.join(runDir, 'results.md');
    const link = dashboard === undefined ? undefined : { name: dashboardName(opts.prefix), region: dashboard.region };
    fs.writeFileSync(resultsFile, renderResults(records, failures, link));
  }
  return { runId: opts.runId, mode, order: slices.map((s) => s.name), failures, ...(signal === undefined ? {} : { signal }), resultsFile };

  async function teardown(s: Slice): Promise<void> {
    const t0 = Date.now();
    // Steps that must run before this slice's teardown (platform mode, `PLATFORM_BEFORE_TEARDOWN`), for the
    // slices that started; their time counts in this slice's destroy seconds, and a failed one is recorded
    // by `verb` and does not stop the teardown (the slice's own teardown names what it still finds).
    for (const a of stepsBeforeTeardown(s.name, slices, mode)) {
      const owner = slices.find((x) => x.name === a.slice);
      if (owner !== undefined && started.has(owner.name)) await verb(owner, 'step', [a.step!]);
    }
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
    own(s, 'lifecycle');
    if (ok) await lifecycleSeconds(s.name, 'destroy', Math.round((Date.now() - t0) / 1000));
  }
}

/**
 * Reads the run's records and adds a failure for each problem: a record
 * that does not parse, does not belong to the run, is for a slice or
 * scenario the run did not run, or changed after its own `run` (or
 * `collect`) last wrote it; a `run` that exited 0 but wrote no record;
 * and the pass criteria of each record (spec §7), P-1 included.
 */
function checkRecords(
  dir: string,
  run: Pick<ResultRecord, 'runId' | 'tier' | 'mode'>,
  ran: ReadonlyMap<string, boolean>,
  owned: ReadonlyMap<string, string | undefined>,
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
    if (!owned.has(f)) wrong.push('not run by this run');
    else if (owned.get(f) !== hashOf(path.join(dir, f))) wrong.push('changed by another verb');
    if (wrong.length > 0) {
      failures.push(`${f}: does not belong to this run (${wrong.join(', ')})`);
      continue;
    }
    failures.push(...recordFailures(r));
    records.push(r);
  }
  for (const [key, ok] of ran) {
    if (ok && !files.includes(`${key}.json`)) {
      const [slice, scenario] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
      failures.push(`${slice} run ${scenario} exited 0 but wrote no ${key}.json`);
    }
  }
  return records;
}
