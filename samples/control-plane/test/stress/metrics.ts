// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Publishes the control-plane slice's figures to the platform stress test's `StressRun` metrics,
 * for the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md §3.1, work item W-12f).
 * It calls the runner's own emitter, `stress/lib/cli.js emit`, which checks the metric and its
 * dimensions and publishes with the run's credentials. It does nothing unless the runner turned
 * the run's metrics on (`STRESS_METRICS=1`): a slice run by hand publishes nothing. A publish
 * that fails is the emitter's warning and never a failure of the scenario: the metrics are a
 * view, and the result record stays the record.
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

type Run = (file: string, args: string[], options: { timeout: number }, done: () => void) => unknown;

/**
 * Sends one data point. The runner's compiled CLI is at `$STRESS_REPO/stress/lib/cli.js` (the
 * runner builds it before it starts a run). Returns whether a call was started.
 */
export function emit(args: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env, run: Run = execFile as unknown as Run): boolean {
  if (args === undefined || env.STRESS_METRICS !== '1' || env.STRESS_REPO === undefined) return false;
  const cli = path.join(env.STRESS_REPO, 'stress', 'lib', 'cli.js');
  if (!fs.existsSync(cli)) return false;
  run('node', [cli, 'emit', ...args], { timeout: 60_000 }, () => undefined);
  return true;
}
