// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Behaviour steps 3, the ones that wait on a clock or read the logs: idle,
 * cold-from-zero, max-life, failed-start, microvm-stop, telemetry (spec §8).
 * `sandboxIdle` is 2 minutes in the integration stack; the steps wait for it
 * and say so in their notes. The reaper's own 5-minute schedule is turned off
 * in the integration stack, so the driver is the only caller (integration-test.md,
 * "Test-only shortcuts").
 */

import { DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { GetMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { TEST_HOOK_FIELDS } from '../../../src/env';
import { sleep, until } from '../aws';
import { clusterArn, containerInstances, insights, liveHandles, logGroupOf, sandboxState, stopOutOfBand, waitEnded } from '../cloud';
import { type Backend, SANDBOX_IDLE_MINUTES, TENANT } from '../common';
import { type Ctx, START_CAP_MS } from '../ctx';
import { type Unit } from '../steps';
import { startedOk } from './basic';

const { a: A, d: D, e: E } = TENANT;
const IDLE_MS = SANDBOX_IDLE_MINUTES * 60_000;

const backendOf = (u: Unit): Backend => {
  if (!u.backend) throw new Error(`step ${u.step} needs a backend`);
  return u.backend;
};

/** The log groups that can hold a tool or stop line: the tool, the standalone function, the reaper and the offboard function. */
async function lineGroups(c: Ctx): Promise<string[]> {
  const names = ['ToolFunction', 'RunCodeFunction', 'ReaperFunction', 'OffboardFunction'].map((n) => c.out[`RunCode${n}`]).filter((x): x is string => !!x);
  return [...new Set(await Promise.all(names.map((n) => logGroupOf(c, n))))];
}

/** Stop lines (spec §3.8) for one handle: rows with `sandboxSeconds`. */
async function stopLines(c: Ctx, handle: string, since: number, want = 0): Promise<Array<Record<string, string>>> {
  const q = `fields @timestamp, handle, sandboxSeconds, runningSeconds, suspendedSeconds, estimated, orphan | filter handle = "${handle}" and ispresent(sandboxSeconds)`;
  return insights(c, await lineGroups(c), q, since, want);
}

/** Runs the reaper once; a pass that threw is a failed check, so it does not surface later as an unrelated one. */
async function reaper(c: Ctx, event: Record<string, unknown> = {}): Promise<void> {
  const r = await c.aws.invoke(c.output('run-code', 'ReaperFunction'), event);
  c.rec.check(`the reaper pass finished without an error (${r.functionError ?? 'none'})`, r.functionError === undefined);
}

/** Waits until the row's `lastUsedAt` is older than `sandboxIdle`, plus a margin. */
async function waitIdle(c: Ctx, backend: Backend, tenant: string): Promise<void> {
  const row = await c.aws.row(c.output('run-code', 'Table'), tenant, backend);
  const last = typeof row?.lastUsedAt === 'number' ? row.lastUsedAt : Date.now();
  const wait = last + IDLE_MS + 15_000 - Date.now();
  if (wait > 0) {
    c.rec.note(`waiting ${Math.ceil(wait / 1000)} s for ${tenant}'s ${backend} sandbox to be idle for ${SANDBOX_IDLE_MINUTES} min`);
    await sleep(wait);
  }
}

export async function idle(c: Ctx): Promise<void> {
  const since = Date.now() - 3_600_000;
  const row = await c.aws.row(c.output('run-code', 'Table'), A, 'nitro');
  const handle = typeof row?.handle === 'string' ? row.handle : undefined;
  c.rec.check('A has a nitro task to idle out', handle !== undefined);
  if (!handle) return;
  await waitIdle(c, 'nitro', A);
  await reaper(c);
  c.rec.check('the idle task is stopped (ended within 4 minutes)', await waitEnded(c, 'nitro', handle, 240_000));
  const after = await c.aws.row(c.output('run-code', 'Table'), A, 'nitro');
  c.rec.check(`A's row is gone or STOPPING (got ${String(after?.state)})`, after === undefined || after.state === 'STOPPING');
  const lines = await stopLines(c, handle, since, 1);
  c.rec.check(`exactly one stop line carries sandboxSeconds (found ${lines.length})`, lines.length === 1 && Number(lines[0].sandboxSeconds) > 0);
}

export async function coldFromZero(c: Ctx): Promise<void> {
  const cap = START_CAP_MS.nitro;
  // Every other nitro task goes idle and is stopped by the reaper; then the instances scale in (ScaleInAfter 120 s).
  const clear = await until(async () => {
    const tasks = await liveHandles(c, 'nitro');
    if (tasks.length > 0) {
      await reaper(c);
      return undefined;
    }
    return (await containerInstances(c)) === 0 ? true : undefined;
  }, 15 * 60_000, 30_000);
  c.rec.check('no task and no container instance runs before the call (waited up to 15 minutes)', clear === true);
  const first = await c.call('run-code', D, { code: 'print("cold")', backend: 'nitro' }, { once: true });
  c.rec.check(`D's first call returns sandbox_starting (got ${first.outcome.kind === 'error' ? first.outcome.code : first.outcome.kind})`, first.outcome.kind === 'error' && first.outcome.code === 'sandbox_starting');
  const t0 = Date.now() - first.ms;
  const handles = new Set<string>();
  let result = first.result;
  let maxLive = 0;
  while (result === undefined && Date.now() - t0 < cap + 60_000) {
    await sleep(5000);
    const row = await c.aws.row(c.output('run-code', 'Table'), D, 'nitro');
    if (typeof row?.handle === 'string') handles.add(row.handle);
    maxLive = Math.max(maxLive, (await liveHandles(c, 'nitro')).length);
    const r = await c.call('run-code', D, { code: 'print("cold")', backend: 'nitro' }, { once: true });
    result = r.result;
  }
  const startMs = Date.now() - t0;
  c.rec.check('the retries reached a result', result !== undefined);
  c.rec.check(`the retries reused one task and started no second (tasks seen ${handles.size}, most running at once ${maxLive})`, handles.size <= 1 && maxLive <= 1);
  c.rec.check(`the nitro start from zero took ${Math.round(startMs / 1000)} s, within half of the ${cap / 1000} s start cap`, startMs <= cap / 2);
  c.rec.latency('nitro', 'cold', startMs);
  c.rec.note(`nitro start from zero ${Math.round(startMs / 1000)} s`);
}

export async function maxLife(c: Ctx): Promise<void> {
  const table = c.output('run-code', 'Table');
  const warm = await c.probe('run-code', A, 'nitro', 'marker', { mode: 'read' });
  c.rec.check('A gets a task', warm.call.result !== undefined);
  const before = await c.aws.row(table, A, 'nitro');
  const handle = typeof before?.handle === 'string' ? before.handle : undefined;
  if (!handle) {
    c.rec.check('A\'s row names a task', false);
    return;
  }
  const age = async (): Promise<number> => {
    const t = (await c.aws.ecs.send(new DescribeTasksCommand({ cluster: clusterArn(c), tasks: [handle] }))).tasks?.[0];
    return t?.startedAt ? Date.now() - t.startedAt.getTime() : 0;
  };
  const old = await until(async () => ((await age()) > 65_000 ? true : undefined), 120_000, 5000);
  c.rec.check('A\'s task is older than 60 s', old === true);
  const longJob = c.call('run-code', A, { code: 'import time\ntime.sleep(15)\nprint("long")', backend: 'nitro' }, { once: true });
  await sleep(3000);
  await reaper(c, { [TEST_HOOK_FIELDS.REAPER_MAX_LIFE_SECONDS]: 60 });
  c.rec.check('the task is stopped by the reaper (ended within 4 minutes)', await waitEnded(c, 'nitro', handle, 240_000));
  const lj = await longJob;
  c.rec.note(`the long job ended with ${lj.outcome.kind}`);
  const next = await c.probe('run-code', A, 'nitro', 'marker', { mode: 'read' });
  const after = await c.aws.row(table, A, 'nitro');
  c.rec.check(`A's next call gets a fresh task (got ${next.call.result?.sandbox})`, startedOk(next.call.result, next.call.starting));
  c.rec.check('the new task is not the old one', after?.handle !== handle);
}

export async function failedStart(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  if (backend !== 'nitro' && backend !== 'microvm') throw new Error('failed-start runs on nitro and microvm');
  const table = c.output('run-code', 'Table');
  const since = Date.now() - 600_000;
  const code = 'print("never runs")';
  const bound = START_CAP_MS[backend] + 120_000;
  const t0 = Date.now();
  let failed = false;
  while (Date.now() - t0 < bound) {
    const r = await c.call('run-code', E, { code, backend }, { once: true });
    if (r.outcome.kind === 'error' && r.outcome.code === 'sandbox_failed') {
      failed = true;
      break;
    }
    await sleep(3000);
  }
  c.rec.check(`E's start fails with sandbox_failed within the start cap (${Math.round((Date.now() - t0) / 1000)} s)`, failed);
  // Everything that must happen before retryAt (30 s after the failure) comes first; the log queries come last.
  const row = await c.aws.row(table, E, backend);
  const handle = typeof row?.handle === 'string' ? row.handle : undefined;
  const retryAt = typeof row?.retryAt === 'number' ? row.retryAt : 0;
  c.rec.check(`E's row is FAILED with a retry time still ahead (state ${String(row?.state)}, ${Math.round((retryAt - Date.now()) / 1000)} s left)`, row?.state === 'FAILED' && retryAt - Date.now() > 5000);
  const live0 = (await liveHandles(c, backend)).length;
  const early = await c.call('run-code', E, { code, backend }, { once: true });
  c.rec.check(`a call before retryAt returns sandbox_failed (got ${early.outcome.kind === 'error' ? early.outcome.code : early.outcome.kind})`, early.outcome.kind === 'error' && early.outcome.code === 'sandbox_failed');
  const live1 = (await liveHandles(c, backend)).length;
  c.rec.check(`it started nothing (live before ${live0}, after ${live1})`, live1 === live0);
  await reaper(c);
  const afterReaper = await c.aws.row(table, E, backend);
  c.rec.check('a reaper run leaves the FAILED row alone', afterReaper?.state === 'FAILED' && afterReaper.version === row?.version);
  const wait = retryAt - Date.now() + 3000;
  if (wait > 0) await sleep(wait);
  await c.call('run-code', E, { code, backend }, { once: true });
  const again = await c.aws.row(table, E, backend);
  const restarted = typeof again?.handle === 'string' && again.handle !== handle && (again.state === 'STARTING' || again.state === 'READY' || again.state === 'FAILED');
  c.rec.check(`a call after retryAt starts again (state ${String(again?.state)}, new handle ${String(typeof again?.handle === 'string' && again.handle !== handle)})`, restarted);
  const stops = handle ? await stopLines(c, handle, since, 1) : [];
  c.rec.check(`exactly one stop line exists for the failed sandbox, none from the reaper run (found ${stops.length})`, stops.length === 1);
  const groups = [await logGroupOf(c, c.output('run-code', 'ToolFunction'))];
  const lines = await insights(c, groups, `fields @timestamp, outcome, stoppedReason | filter tenantId = "${E}" and backend = "${backend}" and ispresent(stoppedReason)`, since, 1);
  c.rec.check(`the tool line carries the reason (found ${lines.length})`, lines.length >= 1 && lines[0].stoppedReason !== '');
}

export async function microvmStop(c: Ctx): Promise<void> {
  const table = c.output('run-code', 'Table');
  const since = Date.now() - 3_600_000;
  const row = await c.aws.row(table, A, 'microvm');
  const handle = typeof row?.handle === 'string' ? row.handle : undefined;
  c.rec.check('A has a MicroVM', handle !== undefined);
  if (!handle) return;
  const suspended = await until(async () => ((await sandboxState(c, 'microvm', handle)) === 'SUSPENDED' ? true : undefined), IDLE_MS + 8 * 60_000, 10_000);
  c.rec.check('A\'s MicroVM, idle past sandboxIdle, shows SUSPENDED', suspended === true);
  await stopOutOfBand(c, 'microvm', handle);
  c.rec.check('the MicroVM ends within 3 minutes', await waitEnded(c, 'microvm', handle, 180_000));
  const g = await c.aws.microvms.send(new GetMicrovmCommand({ microvmIdentifier: handle })).catch(() => undefined);
  c.rec.note(`MicroVM state after the terminate: ${String(g?.state)}`);
  await reaper(c);
  const lines = await stopLines(c, handle, since, 1);
  const l = lines[0] ?? {};
  c.rec.check(`one stop line carries sandboxSeconds, runningSeconds, suspendedSeconds and estimated (found ${lines.length})`,
    lines.length === 1 && [l.sandboxSeconds, l.runningSeconds, l.suspendedSeconds].every((v) => v !== undefined && v !== '') && ['1', 'true'].includes(String(l.estimated)));
  c.rec.check('the row is gone', (await c.aws.row(table, A, 'microvm')) === undefined);
}

export async function telemetry(c: Ctx, u: Unit): Promise<void> {
  const backend = backendOf(u);
  const groups = await lineGroups(c);
  const since = Date.now() - 6 * 3_600_000;
  const runId = c.parseRuns[backend];
  c.rec.check(`the parse call of ${backend} left a run id`, runId !== undefined);
  if (runId) {
    const rows = await insights(c, groups, `fields tenantId, backend, handle, runId, sandbox, outcome, exitCode, timedOut, durationMs, startMs, inputBytes, outputBytes | filter runId = "${runId}"`, since, 1);
    c.rec.check(`one tool line for the parse call (found ${rows.length})`, rows.length === 1);
    const l = rows[0] ?? {};
    c.rec.check('the line has the §3.8 fields', ['tenantId', 'backend', 'handle', 'runId', 'sandbox', 'outcome', 'exitCode', 'timedOut', 'durationMs', 'startMs', 'inputBytes', 'outputBytes'].every((k) => l[k] !== undefined && l[k] !== ''));
    c.rec.check(`tenantId and backend are right (${l.tenantId}, ${l.backend})`, l.tenantId === A && l.backend === backend);
  }
  // One tool line per call: every run id this run's calls returned on the backend has exactly one line.
  const ids = [...new Set(c.runs.filter((r) => r.instance === 'run-code' && r.backend === backend).map((r) => r.runId))].slice(-100);
  const counts = await insights(c, groups, `filter runId in [${ids.map((i) => `"${i}"`).join(', ')}] | stats count(*) as n by runId`, since, ids.length);
  const byId = new Map(counts.map((r) => [r.runId, Number(r.n)]));
  const wrong = ids.filter((i) => byId.get(i) !== 1);
  c.rec.check(`every one of ${ids.length} calls on ${backend} has exactly one tool line (without one: ${wrong.length})`, ids.length > 0 && wrong.length === 0);
}
