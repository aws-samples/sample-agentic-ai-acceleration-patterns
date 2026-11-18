// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { evaluateJsonata } from './workflow-jsonata';

/**
 * A small interpreter for the JSONata states of the hook sub-graph: Pass,
 * Choice, Wait and Task (with `Retry`, `Catch`, `Assign` and `Output`), on a
 * virtual clock. It exists to run the synthesized workflow's own ASL against
 * scripted service answers, because Step Functions cannot be run in a unit
 * test. It models what R-46 relies on and nothing more: it does not model
 * `TimeoutSeconds`, execution limits, or payload size.
 */

export interface TaskCall {
  readonly resource: string;
  readonly args: any;
  /** Virtual time of the call, milliseconds since the epoch. */
  readonly at: number;
  readonly state: string;
}

/** A scripted service: returns the task's result, or throws `{ Error, Cause }`. */
export type TaskHandler = (call: TaskCall) => any;

export interface SimulationOptions {
  readonly definition: { States: Record<string, any> };
  readonly start: string;
  /** The simulation ends on entering any of these states (the workflow's own states, outside the sub-graph). */
  readonly stopAt: readonly string[];
  readonly input: any;
  readonly variables?: Record<string, unknown>;
  readonly handler: TaskHandler;
  readonly executionName?: string;
  readonly startTime?: number;
  /** Stops a runaway loop: the simulation throws after this many state entries. */
  readonly maxSteps?: number;
}

export interface SimulationResult {
  /** The state the simulation stopped in. */
  readonly stoppedAt: string;
  readonly output: any;
  readonly variables: Record<string, any>;
  readonly trace: string[];
  readonly calls: TaskCall[];
  /** Virtual milliseconds from the start to the stop. */
  readonly elapsedMs: number;
  /** History events written, by the counts of the Step Functions event model (Pass, Choice, Wait 2; Task 5, 3 when it fails into a Catch, plus 2 per Retry). */
  readonly historyEvents: number;
}

class ThrownError extends Error {
  constructor(readonly name: string, readonly cause: string) {
    super(`${name}: ${cause}`);
  }
}

export async function simulate(options: SimulationOptions): Promise<SimulationResult> {
  const { definition, handler } = options;
  let now = options.startTime ?? Date.UTC(2026, 10, 18, 9, 0, 0);
  const begun = now;
  let variables: Record<string, any> = { ...(options.variables ?? {}) };
  let input = options.input;
  let name = options.start;
  const trace: string[] = [];
  const calls: TaskCall[] = [];
  let events = 0;
  const context = () => ({
    Execution: { Name: options.executionName ?? 'exec-1' },
    State: { EnteredTime: new Date(now).toISOString() },
  });

  // Every `{% ... %}` string, anywhere in a value, is evaluated.
  const evaluate = async (value: any, states: Record<string, unknown>): Promise<any> => {
    if (typeof value === 'string') {
      return /^\{%[\s\S]*%\}$/.test(value) ? evaluateJsonata(value, states, variables) : value;
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => evaluate(v, states)));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await evaluate(v, states);
      }
      return out;
    }
    return value;
  };
  const assign = async (fields: Record<string, any> | undefined, states: Record<string, unknown>) => {
    if (fields === undefined) {
      return;
    }
    // Every field reads the variables as they were when the state was entered (H-11).
    const computed = await evaluate(fields, states);
    variables = { ...variables, ...computed };
  };

  for (let step = 0; step < (options.maxSteps ?? 20000); step++) {
    if (options.stopAt.includes(name)) {
      return { stoppedAt: name, output: input, variables, trace, calls, elapsedMs: now - begun, historyEvents: events };
    }
    const state = definition.States[name];
    if (state === undefined) {
      throw new Error(`No state ${name}`);
    }
    trace.push(name);
    const base = { input, context: context() };

    switch (state.Type) {
      case 'Pass': {
        events += 2;
        await assign(state.Assign, base);
        input = state.Output === undefined ? input : await evaluate(state.Output, base);
        name = state.Next;
        break;
      }
      case 'Choice': {
        events += 2;
        let next: string | undefined = state.Default;
        for (const rule of state.Choices) {
          if ((await evaluate(rule.Condition, base)) === true) {
            await assign(rule.Assign, base);
            next = rule.Next;
            break;
          }
        }
        if (next === undefined) {
          throw new Error(`No Choice rule matched in ${name}`);
        }
        name = next;
        break;
      }
      case 'Wait': {
        events += 2;
        if (state.Timestamp !== undefined) {
          const at = Date.parse(await evaluate(state.Timestamp, base));
          now = Math.max(now, at);
        } else {
          now += Number(await evaluate(state.Seconds, base)) * 1000;
        }
        name = state.Next;
        break;
      }
      case 'Task': {
        events += 5;
        let args: any;
        let outcome: { result?: any; error?: ThrownError } | undefined;
        try {
          args = await evaluate(state.Arguments, base);
        } catch (e: any) {
          // A JSONata error in Arguments (an `$error()` included) fails the state with this name, before any call.
          outcome = { error: new ThrownError('States.QueryEvaluationError', String(e?.message ?? e)) };
        }
        let attempt = 0;
        const retriers: any[] = state.Retry ?? [];
        const counters = retriers.map(() => 0);
        for (; outcome === undefined;) {
          const call: TaskCall = { resource: state.Resource, args, at: now, state: name };
          calls.push(call);
          try {
            outcome = { result: await handler(call) };
            break;
          } catch (e: any) {
            const error = new ThrownError(e.Error ?? e.name ?? 'States.TaskFailed', e.Cause ?? e.message ?? '');
            const index = retriers.findIndex((r) => matches(r.ErrorEquals, error.name));
            if (index >= 0 && counters[index] < (retriers[index].MaxAttempts ?? 3)) {
              const r = retriers[index];
              now += (r.IntervalSeconds ?? 1) * Math.pow(r.BackoffRate ?? 2, counters[index]) * 1000;
              counters[index] += 1;
              events += 2;
              attempt += 1;
              continue;
            }
            outcome = { error };
            break;
          }
        }
        if (outcome!.error === undefined) {
          const states = { ...base, result: outcome.result };
          await assign(state.Assign, states);
          input = state.Output === undefined ? outcome.result : await evaluate(state.Output, states);
          name = state.Next;
        } else {
          // A call that failed before it started writes three events, not five.
          events -= 2;
          const catcher = (state.Catch ?? []).find((c: any) => matches(c.ErrorEquals, outcome.error!.name));
          if (catcher === undefined) {
            throw new Error(`Unhandled ${outcome.error.message} in ${name}`);
          }
          const states = { ...base, errorOutput: { Error: outcome.error.name, Cause: outcome.error.cause } };
          await assign(catcher.Assign, states);
          input = catcher.Output === undefined ? states.errorOutput : await evaluate(catcher.Output, states);
          name = catcher.Next;
        }
        void attempt;
        break;
      }
      default:
        throw new Error(`State type ${state.Type} of ${name} is not simulated`);
    }
    now += 20;
  }
  throw new Error(`Simulation did not stop within ${options.maxSteps ?? 20000} steps; last states: ${trace.slice(-12).join(' > ')}`);
}

function matches(errorEquals: string[], error: string): boolean {
  return errorEquals.includes('States.ALL') || errorEquals.includes(error);
}
