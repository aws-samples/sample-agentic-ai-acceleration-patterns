// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The step table of spec §8, with the two things the spec leaves implicit:
 * the order the driver runs the steps in (the table order is not the run
 * order) and the step × instance × backend matrix. Pure data and checks, so
 * a unit test proves both against the spec's own list of names.
 */

import type { Backend, Instance } from './common';

export type Phase = 'before-deploy' | 'after-deploy' | 'teardown';

export interface StepSpec {
  readonly name: string;
  /** Before the deploy (checks that need no stack), after it (the behaviour steps), or the teardown. */
  readonly phase: Phase;
  /** Instances the step touches; empty when it touches the stack as a whole. */
  readonly instances: readonly Instance[];
  /** Backends the step runs once each on; empty when the step is not per backend. */
  readonly backends: readonly Backend[];
  /** Steps that must run earlier because they leave the state this one reads. */
  readonly after: readonly string[];
  /** What the step needs from the clock or the account, in a few words. */
  readonly needs?: string;
}

const ALL: readonly Backend[] = ['microvm', 'nitro', 'agentcore'];
const RC: readonly Instance[] = ['run-code'];
const BOTH: readonly Instance[] = ['run-code', 'run-code-files'];

/** Step names in the order of the spec §8 table (the rows, top to bottom). */
export const SPEC_TABLE_ORDER: readonly string[] = [
  'seed', 'parse', 'reuse', 'apart', 'race', 'prefix', 'iam-wall', 'limits', 'no-credentials', 'no-egress',
  'runaway', 'dead-handle', 'recycled-address', 'idle', 'cold-from-zero', 'max-life', 'failed-start',
  'microvm-stop', 'synth', 'session-files', 'dns', 'dns-platform', 'telemetry', 'standalone',
  'standalone-build', 'forged', 'offboard', 'teardown',
];

/**
 * Every step, in RUN order. The driver runs `before-deploy` steps first, then
 * deploys, then `after-deploy` steps, and ends with the teardown.
 *
 * Why the run order differs from the table:
 * - `standalone-build` and `synth` need no stack, so they run before the deploy (a failure there saves the 20-minute deploy).
 * - Steps that leave a sandbox idle for `sandboxIdle` (2 min) come after steps that keep the driver busy: `microvm-stop`, `idle`, `cold-from-zero`, `max-life`.
 * - `cold-from-zero` needs no container instance running, so it follows `idle`, which stops every `nitro` task.
 * - `offboard` follows `race`, which starts tenant C's sandboxes, and runs late because it removes them.
 * - `telemetry` and `dns-platform` read logs that the other steps write, so they run last before the teardown.
 */
export const STEPS: readonly StepSpec[] = [
  { name: 'standalone-build', phase: 'before-deploy', instances: [], backends: [], after: [], needs: 'npm pack, npm install, tsc and cdk synth in a stub consumer' },
  { name: 'synth', phase: 'before-deploy', instances: [], backends: [], after: [], needs: 'the unit tests of the two-instance synth' },
  { name: 'seed', phase: 'after-deploy', instances: BOTH, backends: [], after: [] },
  { name: 'parse', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'reuse', phase: 'after-deploy', instances: RC, backends: ALL, after: ['parse'] },
  { name: 'apart', phase: 'after-deploy', instances: RC, backends: ALL, after: ['reuse'] },
  { name: 'race', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'prefix', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'iam-wall', phase: 'after-deploy', instances: RC, backends: [], after: ['apart'], needs: 'the tenant role and the rows of A and B' },
  { name: 'limits', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'no-credentials', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'no-egress', phase: 'after-deploy', instances: RC, backends: ALL, after: ['apart'], needs: "tenant B's sandbox address" },
  { name: 'dns', phase: 'after-deploy', instances: BOTH, backends: ALL, after: ['seed'], needs: 'the query log, a minute behind' },
  { name: 'runaway', phase: 'after-deploy', instances: RC, backends: ALL, after: ['reuse'] },
  { name: 'session-files', phase: 'after-deploy', instances: ['run-code-files'], backends: ['agentcore'], after: ['seed'] },
  { name: 'standalone', phase: 'after-deploy', instances: RC, backends: ALL, after: ['seed'] },
  { name: 'forged', phase: 'after-deploy', instances: RC, backends: [], after: ['seed'] },
  { name: 'dead-handle', phase: 'after-deploy', instances: RC, backends: ALL, after: ['runaway'] },
  { name: 'recycled-address', phase: 'after-deploy', instances: RC, backends: ['nitro'], after: ['apart', 'dead-handle'] },
  { name: 'microvm-stop', phase: 'after-deploy', instances: RC, backends: ['microvm'], after: ['dead-handle'], needs: 'a MicroVM idle for sandboxIdle (2 min)' },
  { name: 'idle', phase: 'after-deploy', instances: RC, backends: ['nitro'], after: ['recycled-address'], needs: 'a task idle for sandboxIdle (2 min)' },
  { name: 'cold-from-zero', phase: 'after-deploy', instances: RC, backends: ['nitro'], after: ['idle'], needs: 'no container instance running' },
  { name: 'max-life', phase: 'after-deploy', instances: RC, backends: ['nitro'], after: ['cold-from-zero'] },
  { name: 'failed-start', phase: 'after-deploy', instances: RC, backends: ['nitro', 'microvm'], after: ['max-life'] },
  { name: 'offboard', phase: 'after-deploy', instances: RC, backends: [], after: ['race'] },
  { name: 'telemetry', phase: 'after-deploy', instances: RC, backends: ALL, after: ['offboard'], needs: 'Logs Insights, a minute behind' },
  { name: 'dns-platform', phase: 'after-deploy', instances: RC, backends: [], after: ['dns', 'no-egress', 'offboard'], needs: 'the query log, a minute behind' },
  { name: 'teardown', phase: 'teardown', instances: BOTH, backends: ALL, after: ['dns-platform'] },
];

/** One unit of work: a step on one instance and backend (either may be absent). */
export interface Unit {
  readonly step: string;
  readonly instance?: Instance;
  readonly backend?: Backend;
}

/** `step:instance:backend`, the key a run record uses. */
export function unitKey(u: Unit): string {
  return [u.step, u.instance, u.backend].filter((x) => x !== undefined).join(':');
}

/**
 * The step × instance × backend matrix. A per-backend step runs once per
 * backend on the first instance that enables that backend, except `dns` and
 * `teardown`, which also run on the second instance (firewall off; its runtime).
 */
export function matrix(steps: readonly StepSpec[] = STEPS): Unit[] {
  const units: Unit[] = [];
  for (const s of steps) {
    if (s.backends.length === 0) {
      units.push({ step: s.name, ...(s.instances.length === 1 ? { instance: s.instances[0] } : {}) });
      continue;
    }
    for (const b of s.backends) {
      const candidates = s.instances.filter((i) => instanceHas(i, b));
      const wide = s.name === 'dns' || s.name === 'teardown';
      for (const i of wide ? candidates : candidates.slice(0, 1)) units.push({ step: s.name, instance: i, backend: b });
    }
  }
  return units;
}

function instanceHas(i: Instance, b: Backend): boolean {
  return i === 'run-code' || b === 'agentcore';
}

/** Problems with the step list, empty when it is sound. Pure, so a unit test calls it with edited lists too. */
export function validateSteps(steps: readonly StepSpec[] = STEPS, specOrder: readonly string[] = SPEC_TABLE_ORDER): string[] {
  const problems: string[] = [];
  const names = steps.map((s) => s.name);
  if (new Set(names).size !== names.length) problems.push('a step name appears twice');
  const missing = specOrder.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !specOrder.includes(n));
  if (missing.length > 0) problems.push(`steps missing from the run order: ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`steps not in the spec table: ${extra.join(', ')}`);
  const rank: Record<Phase, number> = { 'before-deploy': 0, 'after-deploy': 1, 'teardown': 2 };
  steps.forEach((s, i) => {
    if (i > 0 && rank[s.phase] < rank[steps[i - 1].phase]) problems.push(`${s.name} (${s.phase}) runs after a later phase`);
    for (const a of s.after) {
      const at = names.indexOf(a);
      if (at < 0) problems.push(`${s.name} waits for unknown step ${a}`);
      else if (at >= i) problems.push(`${s.name} runs before ${a}, which it needs`);
    }
    if (s.backends.length > 0 && s.instances.length === 0) problems.push(`${s.name} names backends but no instance`);
    for (const b of s.backends) {
      if (!s.instances.some((inst) => instanceHas(inst, b))) problems.push(`${s.name} names ${b} on an instance that does not enable it`);
    }
  });
  if (steps.length > 0 && steps[steps.length - 1].phase !== 'teardown') problems.push('the last step must be the teardown');
  return problems;
}
