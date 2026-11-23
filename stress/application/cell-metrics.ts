// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The cell's metric filters for the run dashboard (stress ADR-0022, docs/stress-dashboard.design.md
 * §3.2): numbers read off the cell's own structured log lines into the `StressCell` namespace, so a
 * dashboard in the platform account can show a cell account through the observability link. No
 * filter carries a tenant, user, agent or token as a dimension: per-tenant metrics stay off
 * (runtime-isolation ADR-0021), and a test asserts it.
 *
 * It takes the log groups, so it needs no knowledge of the runtime-isolation sample's classes:
 * `cell-app.ts` finds them on the demo stack.
 */

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const CELL_NAMESPACE = 'StressCell';

/** The dimensions a `StressCell` filter may carry: nothing that names a tenant, user, agent or token. */
export const CELL_DIMENSIONS = ['Status', 'Reason', 'Service', 'Mint'] as const;

export interface CellLogGroups {
  /** The API Gateway access log: one JSON line a request, `status` in it. */
  readonly access: logs.ILogGroup;
  /** The ingress function's log: `request served` and `request refused` lines. */
  readonly ingress: logs.ILogGroup;
  /** The authoriser function's log: `request refused`, `token refused` and `sdk retried` lines. */
  readonly authorizer: logs.ILogGroup;
  /** The log group of each tools gateway's interceptor: `sdk retried` lines (its KMS signing). */
  readonly interceptors: readonly logs.ILogGroup[];
}

interface FilterSpec {
  readonly id: string;
  readonly group: logs.ILogGroup;
  readonly pattern: string;
  readonly name: string;
  readonly value: string;
  readonly unit: cloudwatch.Unit;
  /** Dimension name to the JSON field it is read from. */
  readonly dimensions?: Readonly<Record<string, string>>;
}

const message = (text: string): string => `{ $.message = "${text}" }`;

/** The filters of one cell, as data. A breakdown and its total are two filters, because a metric with and without a dimension are two series. */
export function cellFilters(groups: CellLogGroups): FilterSpec[] {
  const count = { value: '1', unit: cloudwatch.Unit.COUNT };
  const filters: FilterSpec[] = [
    { id: 'IngressRequestsByStatus', group: groups.access, pattern: '{ $.status = * }', name: 'IngressRequests', dimensions: { Status: '$.status' }, ...count },
    { id: 'IngressRequestsTotal', group: groups.access, pattern: '{ $.status = * }', name: 'IngressRequests', ...count },
    { id: 'IngressServedMs', group: groups.ingress, pattern: message('request served'), name: 'IngressServedMs', value: '$.totalMs', unit: cloudwatch.Unit.MILLISECONDS },
    { id: 'IngressTtfbMs', group: groups.ingress, pattern: '{ $.message = "request served" && $.ttfbMs = * }', name: 'IngressTtfbMs', value: '$.ttfbMs', unit: cloudwatch.Unit.MILLISECONDS },
    { id: 'IngressRefusedByReason', group: groups.ingress, pattern: message('request refused'), name: 'IngressRefused', dimensions: { Reason: '$.reason', Status: '$.status' }, ...count },
    { id: 'IngressRefusedTotal', group: groups.ingress, pattern: message('request refused'), name: 'IngressRefused', ...count },
    // Two of the authoriser's three `request refused` lines carry a status and one does not: a
    // filter with a Status dimension publishes nothing for a line without the field, so this one
    // takes the reason only.
    { id: 'AuthorizerRefusedByReason', group: groups.authorizer, pattern: message('request refused'), name: 'AuthorizerRefused', dimensions: { Reason: '$.reason' }, ...count },
    { id: 'AuthorizerRefusedTotal', group: groups.authorizer, pattern: message('request refused'), name: 'AuthorizerRefused', ...count },
    { id: 'AuthorizerTokenRefused', group: groups.authorizer, pattern: message('token refused'), name: 'AuthorizerTokenRefused', ...count },
    { id: 'MintLookups', group: groups.ingress, pattern: '{ $.message = "request served" && $.mint = * }', name: 'MintLookups', dimensions: { Mint: '$.mint' }, ...count },
  ];
  // `sdk retried` lines: the ingress, the authoriser (its KMS signing) and each tools interceptor
  // (its KMS signing), all into one metric. KMS limits are per account, so they draw on one quota.
  const retryGroups: [string, logs.ILogGroup][] = [
    ['Ingress', groups.ingress],
    ['Authorizer', groups.authorizer],
    ...groups.interceptors.map((g, i): [string, logs.ILogGroup] => [`Interceptor${i + 1}`, g]),
  ];
  for (const [id, group] of retryGroups) {
    filters.push({ id: `SdkRetriesByService${id}`, group, pattern: message('sdk retried'), name: 'SdkRetryLines', dimensions: { Service: '$.service' }, ...count });
    filters.push({ id: `SdkRetriesTotal${id}`, group, pattern: message('sdk retried'), name: 'SdkRetryLines', ...count });
  }
  return filters;
}

/** Adds the filters to `scope`; each is removed with the cell's stack. */
export function addCellMetricFilters(scope: Construct, groups: CellLogGroups): logs.MetricFilter[] {
  return cellFilters(groups).map(
    (f) =>
      new logs.MetricFilter(scope, `Dash${f.id}`, {
        logGroup: f.group,
        filterPattern: logs.FilterPattern.literal(f.pattern),
        metricNamespace: CELL_NAMESPACE,
        metricName: f.name,
        metricValue: f.value,
        unit: f.unit,
        ...(f.dimensions === undefined ? {} : { dimensions: f.dimensions }),
      }),
  );
}
