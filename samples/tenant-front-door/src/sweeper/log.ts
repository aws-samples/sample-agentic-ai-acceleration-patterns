// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SWEEPER_METRIC_NAMESPACE } from '../shared/contracts';

/**
 * The sweeper's structured log lines and its embedded metric format counts
 * (spec §3.4 step 5). Lines carry identifiers and counts only: a tenant
 * id, a domain, a page number, an error name. Never a token, a challenge
 * token or an error message, which could quote a value.
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * One JSON record per line on stdout. Under the function's JSON log format
 * Lambda wraps a `console.log` line as the `message` string of its own
 * record, so the fields would arrive double-encoded and CloudWatch would
 * extract no metric from an EMF line.
 */
function write(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields = {}): void {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  write({ level, message, ...out });
}

/** One EMF line: `value` of `metric` in `TenantFrontDoor`, no dimensions, unit Count. */
export function emitCount(metric: string, value: number, now: number = Date.now()): void {
  write({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{ Namespace: SWEEPER_METRIC_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: metric, Unit: 'Count' }] }],
    },
    [metric]: value,
  });
}

/** An error's name only: its message could quote a value. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
