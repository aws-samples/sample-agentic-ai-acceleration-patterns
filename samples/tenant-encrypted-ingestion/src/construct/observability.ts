// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant observability (spec P-9, ADR-0012, M-28). Contributor
 * Insights rules on the `tenantId` field of the structured logs give the
 * top tenants at a cost that does not grow with tenants; full per-tenant
 * figures come from the registry counters and Logs Insights.
 */

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

type Filter = { match: string; in: string[] };

function rule(logGroup: logs.ILogGroup, keys: string[], filters: Filter[], valueOf?: string): string {
  return JSON.stringify({
    Schema: { Name: 'CloudWatchLogRule', Version: 1 },
    LogGroupNames: [logGroup.logGroupName],
    LogFormat: 'JSON',
    Contribution: {
      Keys: keys,
      Filters: filters.map((f) => ({ Match: f.match, In: f.in })),
      ...(valueOf !== undefined ? { ValueOf: valueOf } : {}),
    },
    AggregateOn: valueOf !== undefined ? 'Sum' : 'Count',
  });
}

export function createTopTenantRules(
  scope: Construct,
  props: { processorLogs: logs.ILogGroup; apiAccessLogs: logs.ILogGroup },
): cloudwatch.CfnInsightRule[] {
  return [
    new cloudwatch.CfnInsightRule(scope, 'TopTenantsByDeliveries', {
      ruleName: `${scope.node.addr.slice(0, 12)}-tei-top-deliveries`,
      ruleState: 'ENABLED',
      ruleBody: rule(props.processorLogs, ['$.tenantId', '$.status'], [{ match: '$.message', in: ['delivery processed'] }]),
    }),
    new cloudwatch.CfnInsightRule(scope, 'TopTenantsByBytes', {
      ruleName: `${scope.node.addr.slice(0, 12)}-tei-top-bytes`,
      ruleState: 'ENABLED',
      // Only the one 'delivery processed' line per delivery: a re-entry line carries a status too (M-10).
      ruleBody: rule(
        props.processorLogs,
        ['$.tenantId'],
        [
          { match: '$.message', in: ['delivery processed'] },
          { match: '$.status', in: ['ACCEPTED'] },
        ],
        '$.sizeBytes',
      ),
    }),
    new cloudwatch.CfnInsightRule(scope, 'TopTenantsByRequests', {
      ruleName: `${scope.node.addr.slice(0, 12)}-tei-top-requests`,
      ruleState: 'ENABLED',
      // Every tenant route: POST and GET on the collection, GET on one delivery.
      ruleBody: rule(props.apiAccessLogs, ['$.tenantId', '$.status'], [
        {
          match: '$.resourcePath',
          in: ['/tenant/deliveries', '/tenant/deliveries/{deliveryId}'],
        },
      ]),
    }),
  ];
}
