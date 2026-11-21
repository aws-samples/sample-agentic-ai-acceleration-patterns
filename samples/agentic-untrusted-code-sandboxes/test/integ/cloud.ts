// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-backend operations the steps share: listing the live sandboxes of a
 * backend, ending one out of band, reading a log with Logs Insights. All of
 * them use the driver's own credentials, so they see what the tool roles
 * cannot (the registry rows, the tasks of every tenant).
 */

import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { DescribeLogGroupsCommand, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTasksCommand, ListContainerInstancesCommand, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { GetMicrovmCommand, ListMicrovmsCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { sleep, until } from './aws';
import { type Backend, type Instance } from './common';
import { type Ctx } from './ctx';

const LIVE_MICROVM = new Set(['PENDING', 'RUNNING', 'SUSPENDED', 'SUSPENDING']);

export const imageArn = (c: Ctx, i: Instance = 'run-code'): string => c.backendOutput(i, 'microvm', /image/i);
export const clusterArn = (c: Ctx, i: Instance = 'run-code'): string => c.backendOutput(i, 'nitro', /cluster/i);
export const runtimeArn = (c: Ctx, i: Instance = 'run-code'): string => c.backendOutput(i, 'agentcore', /runtime/i);

/** Handles of the live MicroVMs of the sample's image, or the running and pending tasks of its cluster. */
export async function liveHandles(c: Ctx, backend: 'microvm' | 'nitro'): Promise<string[]> {
  if (backend === 'microvm') {
    const handles: string[] = [];
    let token: string | undefined;
    do {
      const r = await c.aws.microvms.send(new ListMicrovmsCommand({ imageIdentifier: imageArn(c), nextToken: token }));
      for (const m of r.items ?? []) if (m.microvmId && m.state && LIVE_MICROVM.has(m.state)) handles.push(m.microvmId);
      token = r.nextToken;
    } while (token);
    return handles;
  }
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await c.aws.ecs.send(new ListTasksCommand({ cluster: clusterArn(c), desiredStatus: 'RUNNING', nextToken: token }));
    arns.push(...(r.taskArns ?? []));
    token = r.nextToken;
  } while (token);
  return arns;
}

/** Ends one sandbox the way an outside event would, with the driver's own credentials. */
export async function stopOutOfBand(c: Ctx, backend: Backend, handle: string): Promise<void> {
  if (backend === 'microvm') {
    await c.aws.microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: handle }));
  } else if (backend === 'nitro') {
    await c.aws.ecs.send(new StopTaskCommand({ cluster: clusterArn(c), task: handle, reason: 'integration test: out-of-band stop' }));
  } else {
    await c.aws.agentcore.send(new StopRuntimeSessionCommand({ agentRuntimeArn: runtimeArn(c), runtimeSessionId: handle }));
  }
}

/** The state a sandbox is in, or `gone`; `agentcore` has none to read, so it answers `unknown`. */
export async function sandboxState(c: Ctx, backend: Backend, handle: string): Promise<string> {
  if (backend === 'microvm') {
    try {
      return (await c.aws.microvms.send(new GetMicrovmCommand({ microvmIdentifier: handle }))).state ?? 'unknown';
    } catch {
      return 'gone';
    }
  }
  if (backend === 'nitro') {
    const r = await c.aws.ecs.send(new DescribeTasksCommand({ cluster: clusterArn(c), tasks: [handle] }));
    return r.tasks?.[0]?.lastStatus ?? 'gone';
  }
  return 'unknown';
}

export const ENDED = new Set(['STOPPED', 'TERMINATED', 'gone']);

/** When the platform says a MicroVM ended, in ms; undefined when it does not say or the MicroVM is gone. */
export async function microvmTerminatedAt(c: Ctx, handle: string): Promise<number | undefined> {
  try {
    const t = (await c.aws.microvms.send(new GetMicrovmCommand({ microvmIdentifier: handle }))).terminatedAt;
    return t === undefined ? undefined : new Date(t).getTime();
  } catch {
    return undefined;
  }
}

/** Waits until a sandbox reports an ended state; false when the deadline passes first. */
export async function waitEnded(c: Ctx, backend: 'microvm' | 'nitro', handle: string, deadlineMs: number): Promise<boolean> {
  const v = await until(async () => (ENDED.has(await sandboxState(c, backend, handle)) ? true : undefined), deadlineMs, 5000);
  return v === true;
}

/** Container instances in the cluster (the `nitro` capacity). */
export async function containerInstances(c: Ctx): Promise<number> {
  const r = await c.aws.ecs.send(new ListContainerInstancesCommand({ cluster: clusterArn(c) }));
  return r.containerInstanceArns?.length ?? 0;
}

/** The log group a function writes to. */
export async function logGroupOf(c: Ctx, functionName: string): Promise<string> {
  const r = await c.aws.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  return r.LoggingConfig?.LogGroup ?? `/aws/lambda/${functionName}`;
}

/**
 * A Logs Insights query over the groups, from `sinceMs`, polled until it is
 * complete. Returns rows as field maps. Logs reach Insights a short time after
 * they are written, so callers pass `want` (rows expected) to keep polling.
 */
export async function insights(
  c: Ctx, groups: string[], query: string, sinceMs: number, want = 0, deadlineMs = 180_000,
): Promise<Array<Record<string, string>>> {
  let rows: Array<Record<string, string>> = [];
  const end = Date.now() + deadlineMs;
  for (;;) {
    const s = await c.aws.logs.send(new StartQueryCommand({
      logGroupNames: groups,
      startTime: Math.floor(sinceMs / 1000),
      endTime: Math.floor(Date.now() / 1000) + 60,
      queryString: query,
      limit: 1000,
    }));
    for (;;) {
      await sleep(2000);
      const r = await c.aws.logs.send(new GetQueryResultsCommand({ queryId: s.queryId }));
      if (r.status === 'Complete') {
        rows = (r.results ?? []).map((row) => Object.fromEntries(row.filter((f) => f.field !== '@ptr').map((f) => [f.field ?? '', f.value ?? ''])));
        break;
      }
      if (r.status === 'Failed' || r.status === 'Cancelled' || r.status === 'Timeout') throw new Error(`Logs Insights query ${r.status}`);
    }
    if (rows.length >= want || Date.now() + 15_000 > end) return rows;
    await sleep(15_000);
  }
}

/** How many log lines a failed check keeps as evidence, and how long each line may be. */
export const EVIDENCE_LINES = 20;
export const EVIDENCE_LINE_CHARS = 300;

/** Log lines cut to a size a run record can hold: the last `EVIDENCE_LINES`, each at most `EVIDENCE_LINE_CHARS`. Pure. */
export function evidenceLines(messages: readonly string[]): string[] {
  return messages.slice(-EVIDENCE_LINES).map((m) => m.replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_LINE_CHARS));
}

/**
 * The log groups of the runner on a backend, for evidence: on `agentcore` the runtime's own groups
 * (`/aws/bedrock-agentcore/runtimes/<runtimeName>-*`). Other backends give none: their runner lines are in
 * groups the driver does not name.
 */
export async function runnerGroups(c: Ctx, instance: Instance, backend: Backend): Promise<string[]> {
  if (backend !== 'agentcore') return [];
  const arn = runtimeArn(c, instance);
  const rt = await c.aws.agentcoreControl.send(new GetAgentRuntimeCommand({ agentRuntimeId: arn.split('/').pop() ?? arn }));
  if (!rt.agentRuntimeName) return [];
  const r = await c.aws.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: `/aws/bedrock-agentcore/runtimes/${rt.agentRuntimeName}-` }));
  return (r.logGroups ?? []).map((g) => g.logGroupName).filter((n): n is string => !!n);
}

/**
 * Log lines from the groups since `sinceMs`, for a failed check's evidence. Read while the stack (and so the
 * groups) still exists, because the teardown deletes them. A read that fails gives the error instead.
 */
export async function logEvidence(c: Ctx, groups: readonly string[], sinceMs: number, filter = ''): Promise<string[]> {
  if (groups.length === 0) return [];
  try {
    const q = `fields @timestamp, @message${filter ? ` | filter ${filter}` : ''} | sort @timestamp asc | limit 1000`;
    const rows = await insights(c, [...groups], q, sinceMs, 1, 60_000);
    return evidenceLines(rows.map((r) => `${r['@timestamp'] ?? ''} ${r['@message'] ?? ''}`));
  } catch (e) {
    return [`log read failed: ${(e as Error).name}`];
  }
}
