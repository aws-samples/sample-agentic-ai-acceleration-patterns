// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Slice } from './slice';

/**
 * The platform run's set-up and teardown order (spec §3.5). A platform run composes slices
 * whose set-up steps interleave: the front door's first deploy needs the control plane, the
 * control plane's application needs the front door's distribution, and the front door's
 * second phase needs the cell the control plane built. One slice's `deploy` and `seed` run
 * one after the other cannot express that, so the runner owns this table and calls each
 * slice's `deploy`, `seed` or `step <name>` in this order.
 */

export interface Action {
  readonly slice: string;
  readonly verb: 'deploy' | 'seed' | 'step';
  /** The step's name, for `verb: 'step'`. */
  readonly step?: string;
  /** The action only makes sense with this other slice in the run; without it the action is skipped. */
  readonly requires?: string;
}

const deploy = (slice: string): Action => ({ slice, verb: 'deploy' });
const seed = (slice: string): Action => ({ slice, verb: 'seed' });
const step = (slice: string, name: string, requires?: string): Action => ({ slice, verb: 'step', step: name, ...(requires === undefined ? {} : { requires }) });

/**
 * Spec §3.5, steps 1 to 6, then the k6 host of the runtime-isolation slice. An entry for a
 * slice the run does not include is skipped, so a smaller platform run keeps the order of
 * the slices it has.
 */
export const PLATFORM_SETUP: readonly Action[] = [
  deploy('tenant-identity'),
  seed('tenant-identity'),
  deploy('control-plane'),
  seed('control-plane'),
  // Front-door phase one: the edge, the main stack, the registrar and RouteHookAccess.
  deploy('tenant-front-door'),
  seed('tenant-front-door'),
  // The hook policy goes on the control plane and the hooks are registered, before the first cell build.
  step('control-plane', 'hooks', 'tenant-front-door'),
  // The stress application, with the distribution ARN as its cell parameter, and the cell account.
  step('control-plane', 'register'),
  // One tenant alone builds the cell; the hooks write the cell and tenant routes.
  step('control-plane', 'warm-up'),
  // Front-door phase two: `agentIngress` is that cell's ingress.
  step('tenant-front-door', 'phase-two'),
  deploy('agentic-runtime-isolation'),
  seed('agentic-runtime-isolation'),
];

/**
 * Steps that run before a slice's `teardown` in a platform run (spec §3.5): the control plane
 * unregisters the front door's hooks and takes the hook policy off its hook role before the
 * front door removes `RouteHookAccess`, and while it can still delete cells with no call to
 * a registrar that is gone.
 */
export const PLATFORM_BEFORE_TEARDOWN: readonly { readonly before: string; readonly action: Action }[] = [
  { before: 'tenant-front-door', action: step('control-plane', 'unhook', 'tenant-front-door') },
];

/**
 * The actions of the set-up, in order. Slice mode: each slice's `deploy` then `seed`, in the
 * order of their needs. Platform mode: `PLATFORM_SETUP` for the slices in the run, then
 * `deploy` and `seed` of any slice the table does not name. Refuses a table entry for a step
 * the slice's declaration does not list, so the table and the declarations cannot drift.
 */
export function setupActions(slices: readonly Slice[], mode: 'slice' | 'platform'): Action[] {
  const own = slices.flatMap((s): Action[] => [deploy(s.name), seed(s.name)]);
  if (mode === 'slice') return own;
  const byName = new Map(slices.map((s) => [s.name, s]));
  const applies = (a: Action): boolean => byName.has(a.slice) && (a.requires === undefined || byName.has(a.requires));
  const listed = PLATFORM_SETUP.filter(applies);
  const named = new Set(PLATFORM_SETUP.map((a) => a.slice));
  const rest = own.filter((a) => !named.has(a.slice));
  const missing = [...listed, ...PLATFORM_BEFORE_TEARDOWN.map((b) => b.action).filter(applies)]
    .filter((a) => a.verb === 'step' && !byName.get(a.slice)!.steps.includes(a.step!));
  if (missing.length > 0) {
    throw new Error(`the platform order calls ${missing.map((a) => `${a.slice} step ${a.step}`).join(', ')}, which the slice's slice.json does not list under "steps"`);
  }
  return [...listed, ...rest];
}

/** The steps to run before `slice`'s teardown, for the slices in the run. */
export function stepsBeforeTeardown(slice: string, slices: readonly Slice[], mode: 'slice' | 'platform'): Action[] {
  if (mode !== 'platform') return [];
  const present = new Set(slices.map((s) => s.name));
  return PLATFORM_BEFORE_TEARDOWN.filter((b) => b.before === slice && present.has(b.action.slice)).map((b) => b.action);
}
