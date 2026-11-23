// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// The minute line of the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md §5): what
// one VU counted in one epoch minute, as the relay (`relay.sh`) reads it. No k6 import, so the
// contract's tests run this file as it is, like `record.js`; `lib.js` keeps the per-VU state and
// prints the lines. A line holds counts only: no tenant, token or header.

// Latency buckets are log-spaced and about 12 % wide, from 1 ms to 120 s: at most 105, below the
// 150 values CloudWatch takes in one histogram data point. Bucket i holds latencies up to 1.12^i ms.
export const LATENCY_STEP = Math.log(1.12);
export const LATENCY_MAX_BUCKET = Math.ceil(Math.log(120000) / LATENCY_STEP);

/** The counts a minute line carries, besides the `hist` object. The relay sums these keys. */
export const COUNT_KEYS = ['s2xx', 's3xx', 's4xx', 's5xx', 'snone', 'assertions', 'mismatches', 'refusals'];

/** An empty minute of one VU: zero counts and no latency. */
export function newStat(minute, nowMs = 0) {
  const stat = { minute, since: nowMs, hist: {} };
  for (const key of COUNT_KEYS) {
    stat[key] = 0;
  }
  return stat;
}

/** The count key for the status of a response: s2xx to s5xx, or snone for 0 or an unusual status. */
export function statusClass(status) {
  return status >= 200 && status < 600 ? `s${Math.floor(status / 100)}xx` : 'snone';
}

/** The log-spaced bucket of a latency in ms; 0 for NaN or anything below 1 ms. */
export function latencyBucket(ms) {
  if (!(ms > 1)) {
    return 0;
  }
  return Math.min(LATENCY_MAX_BUCKET, Math.ceil(Math.log(ms) / LATENCY_STEP));
}

/** A VU prints what it has counted at least this often while a minute goes on. */
export const LINE_EVERY_MS = 5000;
/** The share of a scenario after which a VU prints on every call, at most once per TAIL_EVERY_MS. */
export const TAIL_START = 0.95;
export const TAIL_EVERY_MS = 1000;

/** The state of one VU: the stat of its current minute, when it last printed, and the iteration a print began in. */
export function newVuState() {
  return { stat: null, lastPrintMs: 0, printIteration: null, statIteration: null, iterationMinute: 0, scenario: undefined };
}

/**
 * Applies one count to a VU's minute and prints (through `print(stat)`) when a line is due: the
 * minute has changed (at the next iteration: the old minute prints, the count goes to the new one;
 * an iteration that began before the edge stays in the minute of its first count), the minute's stat is
 * LINE_EVERY_MS old, or the scenario is in its last 5 % and the VU last printed TAIL_EVERY_MS ago.
 * A request makes up to three `bump` calls (its status, its timing, its assertion), all in one
 * iteration. The rule is decided once for an iteration: a print that begins in an iteration goes
 * on in it, on every call, so the counts of a request are never split between a line and the end
 * of a scenario. `iteration` is the VU's own iteration number in `scenario` (a VU that runs
 * a second scenario starts again at 0); a value that is not an integer
 * (a k6 without the property) makes every call due, which prints more lines and loses nothing.
 * A printed stat is dropped, so each count is in exactly one line; the relay adds the lines of a
 * minute up. k6 has no per-VU end hook: what a VU counts after its last line is lost, and that is
 * whole requests. A VU that is called in the last 5 % of a scenario loses at most those of
 * TAIL_EVERY_MS, one that is not holds up to LINE_EVERY_MS.
 */
export function bump(state, nowMs, progress, apply, print, iteration, scenario) {
  // A VU that is reused by the next scenario starts its iterations at 0 again: forget the old scenario's iteration.
  if (state.scenario !== scenario) {
    state.scenario = scenario;
    state.statIteration = null;
    state.printIteration = null;
  }
  // An iteration counts in the minute of its first count: the minute is taken once for an iteration, so the stat
  // changes minute at the next iteration, not inside one (whether or not a print began at the first count).
  const sameIteration = Number.isInteger(iteration) && state.statIteration === iteration;
  const minute = sameIteration ? state.iterationMinute : Math.floor(nowMs / 60000);
  state.iterationMinute = minute;
  if (state.stat !== null && state.stat.minute !== minute) {
    // `lastPrintMs` stays: a call that is the first of a new minute is not made due by this print.
    print(state.stat);
    state.stat = null;
  }
  state.stat = state.stat || newStat(minute, nowMs);
  apply(state.stat);
  state.statIteration = iteration;
  let due = !Number.isInteger(iteration) || state.printIteration === iteration;
  if (!due) {
    due = progress >= TAIL_START ? nowMs - state.lastPrintMs >= TAIL_EVERY_MS : nowMs - state.stat.since >= LINE_EVERY_MS;
  }
  if (due) {
    state.printIteration = iteration;
    print(state.stat);
    state.stat = null;
    state.lastPrintMs = nowMs;
  }
}

/** The line a VU prints for its stat: `{kind: 'minute', epochMinute, vu, <counts>, hist}`. */
export function minuteLine(stat, vu) {
  const line = { kind: 'minute', epochMinute: stat.minute, vu };
  for (const key of COUNT_KEYS) {
    line[key] = stat[key];
  }
  line.hist = stat.hist;
  return line;
}
