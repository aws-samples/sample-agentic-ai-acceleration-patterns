// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Publishes the control-plane slice's figures to the platform stress test's `StressRun` metrics,
 * for the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md, work item W-12f).
 * It calls the runner's own emitter, `stress/lib/cli.js emit`, which checks the metric and its
 * dimensions and publishes with the run's credentials. It does nothing unless the runner turned
 * the run's metrics on (`STRESS_METRICS=1`): a slice run by hand publishes nothing. A publish
 * that fails is the emitter's warning and never a failure of the scenario: the metrics are a
 * view, and the result record stays the record.
 *
 * The calls go one at a time, in order, and `flush()` waits for them: the driver ends with
 * `process.exit`, which would otherwise drop the points still in flight.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The recorder's hops that are a dashboard metric: PS-1's ready time and PS-5's three change times. */
const HOP_METRICS: Readonly<Record<string, string>> = {
  ready: 'OnboardReadySeconds',
  routable: 'RoutableSeconds',
  suspended: 'SuspendedSeconds',
  removed: 'RemovedSeconds',
};

/** The `emit` arguments for a timing of the recorder, or undefined when the hop is no dashboard metric. */
export function sampleArgs(hop: string, seconds: number): string[] | undefined {
  const name = HOP_METRICS[hop];
  return name === undefined || !Number.isFinite(seconds) || seconds < 0 ? undefined : [name, String(Math.round(seconds * 1000) / 1000)];
}

/** The `emit` arguments for the builds in flight: the slice's draw on the platform's concurrent builds (spec §4.4). */
export function buildsArgs(account: string, quota: string, inFlight: number): string[] | undefined {
  return account === 'platform' && quota === 'codebuild-linux-small' ? ['BuildsInFlight', String(inFlight)] : undefined;
}

/** Runs `file args` and calls `done` when it has ended, however it ended. */
export type Run = (file: string, args: string[], options: { timeout: number }, done: () => void) => unknown;

/** The builds in flight are sent at most this often, and at once when they fall to 0 (design §3.1: every 15 s). */
export const BUILDS_EVERY_MS = 15_000;

/** `flush()` waits this long for the calls in flight, then gives up on them: the dashboard is a view. */
export const FLUSH_DEADLINE_MS = 30_000;

export interface MetricsQueue {
  /** Queues one data point; returns whether a call was queued. */
  emit(args: readonly string[] | undefined): boolean;
  /** Queues the builds in flight, throttled to one every `BUILDS_EVERY_MS`; a throttled value is kept and sent by `flush()`. */
  builds(account: string, quota: string, inFlight: number, nowMs?: number): boolean;
  /** Resolves when every queued call has ended, or after `FLUSH_DEADLINE_MS`. */
  flush(): Promise<void>;
}

/**
 * A queue of `emit` calls. The runner's compiled CLI is at `$STRESS_REPO/stress/lib/cli.js` (the
 * runner builds it before it starts a run).
 */
export function metricsQueue(env: NodeJS.ProcessEnv = process.env, run: Run = execFile as unknown as Run): MetricsQueue {
  let chain: Promise<void> = Promise.resolve();
  let lastBuildsMs = Number.NEGATIVE_INFINITY;
  let held: string[] | undefined;
  const enabled = (): string | undefined => {
    if (env.STRESS_METRICS !== '1' || env.STRESS_REPO === undefined) return undefined;
    const cli = path.join(env.STRESS_REPO, 'stress', 'lib', 'cli.js');
    return fs.existsSync(cli) ? cli : undefined;
  };
  const queue: MetricsQueue = {
    emit(args) {
      const cli = enabled();
      if (args === undefined || cli === undefined) return false;
      // A call that throws or never ends must not stop the calls behind it: `.catch` keeps the chain alive.
      chain = chain
        .then(() => new Promise<void>((resolve) => void run('node', [cli, 'emit', ...args], { timeout: 60_000 }, () => resolve())))
        .catch(() => undefined);
      return true;
    },
    builds(account, quota, inFlight, nowMs = Date.now()) {
      const args = buildsArgs(account, quota, inFlight);
      if (args === undefined) return false;
      if (nowMs - lastBuildsMs < BUILDS_EVERY_MS && inFlight !== 0) {
        held = args;
        return false;
      }
      held = undefined;
      lastBuildsMs = nowMs;
      return queue.emit(args);
    },
    async flush() {
      // The last value that was held back goes out now, so the dashboard's line ends on the last figure.
      if (held !== undefined) {
        const last = held;
        held = undefined;
        queue.emit(last);
      }
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_DEADLINE_MS);
        timer.unref();
      });
      await Promise.race([chain, deadline]);
      clearTimeout(timer);
    },
  };
  return queue;
}

/** The slice driver's own queue. */
export const metrics = metricsQueue();
