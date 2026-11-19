// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { METRIC_NAMESPACE, METRIC_ROUTE_TABLE_BYTES } from '../shared/route-table';

/**
 * Structured log lines (spec §3.4 step 6): the caller role, the key and
 * the outcome, never a request body, a token or a secret. Callers pass
 * identifiers only.
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

export function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields = {}): void {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, message, ...out }));
}

/**
 * The store-size metric (spec §4.1, ADR-0012): one embedded metric format
 * line with `RouteTableBytes` in namespace `TenantFrontDoor`, no
 * dimensions, unit Bytes. The alarm reads its maximum.
 */
export function emitRouteTableBytes(bytes: number, now: number = Date.now()): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: METRIC_ROUTE_TABLE_BYTES, Unit: 'Bytes' }] }],
    },
    [METRIC_ROUTE_TABLE_BYTES]: bytes,
  }));
}
