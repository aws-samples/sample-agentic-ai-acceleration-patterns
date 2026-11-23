// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Runs the steps of one phase, one unit at a time, in the order of
 * `steps.ts`. A step that throws is recorded as a failure and the run goes on
 * (a later step may not need what the failed one left). Pure apart from the
 * calls the implementations make, so a unit test drives it with fakes.
 */

import { type Recorder } from './record';
import { matrix, type Phase, type StepSpec, unitKey, type Unit } from './steps';

export type UnitImpl<C> = (ctx: C, unit: Unit) => Promise<void>;

export async function runPhase<C>(
  rec: Recorder,
  ctx: C,
  steps: readonly StepSpec[],
  phase: Phase,
  impls: Readonly<Record<string, UnitImpl<C>>>,
  stopped: () => boolean = () => false,
): Promise<void> {
  for (const step of steps.filter((s) => s.phase === phase)) {
    const impl = impls[step.name];
    for (const unit of matrix([step])) {
      if (stopped()) {
        rec.skip(unitKey(unit), 'the run was stopped');
        continue;
      }
      if (!impl) {
        rec.skip(unitKey(unit), 'no implementation');
        continue;
      }
      rec.begin(unitKey(unit));
      try {
        await impl(ctx, unit);
      } catch (e) {
        rec.crashed(e);
      }
      rec.end();
    }
  }
}

/** Marks every unit of the phase as skipped (a step that cannot run because an earlier phase failed). */
export function skipPhase(rec: Recorder, steps: readonly StepSpec[], phase: Phase, reason: string): void {
  for (const step of steps.filter((s) => s.phase === phase)) for (const unit of matrix([step])) rec.skip(unitKey(unit), reason);
}
