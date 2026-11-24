// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `teardown` step (spec §8): the stack is deleted with sandboxes still
 * running for A and B, and afterwards no MicroVM, task, instance or log group
 * of the sample is left, no DNS Firewall resource, and the Logs resource
 * policies match their state before the deploy (a difference is reported as
 * the §3.9 known leftover). The runtime is gone.
 */

import { type Aws } from '../aws';
import { type Backend, TENANT } from '../common';
import { type Ctx } from '../ctx';
import { destroyStack } from '../deploy';
import { checkLeftovers, formatFindings, type Finding } from '../leftovers';
import { type Recorder } from '../record';
import { type RunState } from '../state';
import { type Unit } from '../steps';

const KINDS: Readonly<Record<Backend, readonly string[]>> = {
  microvm: ['microvm'],
  nitro: ['ecs-cluster', 'container-instance', 'task-definition'],
  agentcore: ['runtime'],
};

/** Starts a sandbox for A and B on every backend, so the destroy runs with sandboxes alive (spec §8). */
export async function prepareTeardown(c: Ctx): Promise<void> {
  for (const backend of ['microvm', 'nitro', 'agentcore'] as const) {
    for (const tenant of [TENANT.a, TENANT.b]) {
      const r = await c.call('run-code', tenant, { code: 'print("alive")', backend }).catch(() => undefined);
      if (r?.result === undefined) c.rec.note(`no live sandbox for ${tenant} on ${backend} before the destroy`);
    }
  }
}

export interface TeardownOutcome {
  readonly findings: Finding[];
  readonly destroyed: boolean;
}

/** Deletes the stack (timed), then looks for leftovers. */
export async function destroyAndCheck(aws: Aws, rec: Recorder, prefix: string, state: RunState): Promise<TeardownOutcome> {
  const result = await rec.time('destroy', () => destroyStack(aws, state.stackName));
  if (!result.ok) rec.note(`stack ${state.stackName} is ${result.status}: ${result.failures.join(' | ')}`);
  const findings = await checkLeftovers(aws, prefix, state);
  process.stdout.write(`${formatFindings(findings)}\n`);
  return { findings, destroyed: result.ok };
}

/** One unit of the teardown step: the checks of one backend on one instance. */
export function teardownUnit(rec: Recorder, u: Unit, outcome: TeardownOutcome, isFirst: boolean): void {
  const backend = u.backend as Backend;
  const mine = outcome.findings.filter((f) => !f.known && KINDS[backend].includes(f.kind));
  const unavailable = outcome.findings.filter((f) => f.kind === 'check-unavailable');
  const state = mine.map((f) => `${f.kind} ${f.id}`).join(', ') || (unavailable.length > 0 ? 'not checked, the leftover check could not run' : 'clean');
  rec.check(`the stack deleted (nothing left of ${backend}: ${state})`, outcome.destroyed && mine.length === 0 && unavailable.length === 0);
  if (u.instance === 'run-code' && backend === 'agentcore') {
    const logs = outcome.findings.filter((f) => f.kind === 'log-group' && f.id.startsWith('/aws/bedrock-agentcore/'));
    rec.check(`no AgentCore runtime log group is left (${unavailable.length > 0 ? 'not checked' : logs.length})`, logs.length === 0 && unavailable.length === 0);
  }
  if (u.instance === 'run-code' && backend === 'microvm') {
    const logs = outcome.findings.filter((f) => f.kind === 'log-group' && f.id.startsWith('/aws/lambda-microvms/'));
    rec.check(`no MicroVM image log group is left (${unavailable.length > 0 ? 'not checked' : logs.length})`, logs.length === 0 && unavailable.length === 0);
  }
  if (isFirst) {
    rec.check(`the leftover check could run (${unavailable.map((f) => `${f.id}: ${f.detail}`).join('; ') || 'yes'})`, unavailable.length === 0);
    const other = outcome.findings.filter((f) => !f.known && !Object.values(KINDS).some((k) => k.includes(f.kind)) && f.kind !== 'log-group' && f.kind !== 'check-unavailable');
    rec.check(`no other resource of the run is left (${other.map((f) => `${f.kind} ${f.id}`).join(', ') || 'none'})`, other.length === 0);
    const groups = outcome.findings.filter((f) => f.kind === 'log-group' && !f.id.startsWith('/aws/bedrock-agentcore/') && !f.id.startsWith('/aws/lambda-microvms/'));
    rec.check(`no log group of the sample is left (${groups.length})`, groups.length === 0);
    for (const f of outcome.findings.filter((x) => x.known)) rec.note(`known leftover (C-6, spec §3.9): ${f.kind} ${f.id}: ${f.detail}`);
  }
}
