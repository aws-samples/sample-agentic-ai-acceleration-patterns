// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { METRIC_DIMENSION_DISTRIBUTION, METRIC_NAMESPACE, METRIC_ROUTE_TABLE_BYTES } from '../shared/route-table';

/**
 * Structured log lines (spec §3.4 step 6): the caller role, the key and
 * the outcome, never a request body, a token or a secret. Callers pass
 * identifiers only.
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * One JSON record per line on stdout. Not `console.log`: under the
 * function's JSON log format Lambda wraps a `console.log` line as the
 * `message` string of its own record, so the fields would arrive
 * double-encoded and CloudWatch would extract no EMF metric from it.
 */
function write(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields = {}): void {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  write({ level, message, ...out });
}

/**
 * The store-size metric (spec §4.1, ADR-0012): one embedded metric format
 * line with `RouteTableBytes` in namespace `TenantFrontDoor`, dimension
 * `DistributionId`, unit Bytes, so two front doors in one account and
 * Region keep apart. The alarm reads its maximum.
 */
export function emitRouteTableBytes(bytes: number, distributionId: string, now: number = Date.now()): void {
  write({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [[METRIC_DIMENSION_DISTRIBUTION]],
        Metrics: [{ Name: METRIC_ROUTE_TABLE_BYTES, Unit: 'Bytes' }],
      }],
    },
    [METRIC_DIMENSION_DISTRIBUTION]: distributionId,
    [METRIC_ROUTE_TABLE_BYTES]: bytes,
  });
}
