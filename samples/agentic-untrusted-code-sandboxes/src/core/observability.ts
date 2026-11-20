// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Lazy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import type { NameFor } from '../backend-construct';

/**
 * The Contributor Insights rules of spec §3.8 (ADR-0013). They read the
 * structured lines the functions write with `process.stdout.write`, whose
 * top-level fields they key on:
 *
 * - runs by tenant: one count per run line (`runId` present), keyed on `tenantId`;
 * - sandbox seconds by tenant: the sum of `sandboxSeconds` on stop lines, keyed on `tenantId`,
 *   over every function that writes a stop line (tool, reaper, drain, offboard);
 * - with the DNS Firewall: blocked lookups by `srcaddr` on the query log.
 *
 * Log groups are added after construction (a function bound with
 * `bindRunCode` brings its own), so each rule body is built at synth.
 */
export class InsightRules extends Construct {
  private readonly toolGroups: string[] = [];
  private readonly stopGroups: string[] = [];
  public readonly runsByTenant: cloudwatch.CfnInsightRule;
  public readonly secondsByTenant: cloudwatch.CfnInsightRule;
  public dnsBlocked?: cloudwatch.CfnInsightRule;

  public constructor(scope: Construct, id: string, private readonly nameFor: NameFor) {
    super(scope, id);
    this.runsByTenant = new cloudwatch.CfnInsightRule(this, 'RunsByTenant', {
      ruleName: nameFor('contributor-insights-rule', 'runs-by-tenant'),
      ruleState: 'ENABLED',
      ruleBody: Lazy.string({
        produce: () => ruleBody(this.toolGroups, '$.tenantId', 'Count', [{ Match: '$.runId', IsPresent: true }]),
      }),
    });
    this.secondsByTenant = new cloudwatch.CfnInsightRule(this, 'SecondsByTenant', {
      ruleName: nameFor('contributor-insights-rule', 'sandbox-seconds-by-tenant'),
      ruleState: 'ENABLED',
      ruleBody: Lazy.string({
        produce: () => ruleBody(this.stopGroups, '$.tenantId', 'Sum', [{ Match: '$.sandboxSeconds', IsPresent: true }], '$.sandboxSeconds'),
      }),
    });
  }

  /** A function that writes run lines; it also writes stop lines. Takes the log group name. */
  public addToolLogGroup(group: string): void {
    this.toolGroups.push(group);
    this.stopGroups.push(group);
  }

  /** A function that writes stop lines only (reaper, drain, offboard). */
  public addStopLogGroup(group: string): void {
    this.stopGroups.push(group);
  }

  public addDnsBlocked(queryLogGroup: string): void {
    this.dnsBlocked = new cloudwatch.CfnInsightRule(this, 'DnsBlocked', {
      ruleName: this.nameFor('contributor-insights-rule', 'dns-blocked-by-source'),
      ruleState: 'ENABLED',
      ruleBody: ruleBody([queryLogGroup], '$.srcaddr', 'Count', [{ Match: '$.firewall_rule_action', In: ['BLOCK'] }]),
    });
  }
}

interface RuleFilter {
  readonly Match: string;
  readonly IsPresent?: boolean;
  /** Strings go in `In`; `EqualTo` takes a number only, and CloudWatch refuses a string there (INVALID_RULE_BODY). */
  readonly In?: string[];
}

/** The rule body JSON of a CloudWatchLogRule, version 1. Exported for the unit test. */
export function ruleBody(
  groups: readonly string[],
  key: string,
  aggregateOn: 'Count' | 'Sum',
  filters: readonly RuleFilter[],
  valueOf?: string,
): string {
  return JSON.stringify({
    Schema: { Name: 'CloudWatchLogRule', Version: 1 },
    LogGroupNames: [...groups],
    LogFormat: 'JSON',
    Contribution: {
      Keys: [key],
      ...(valueOf ? { ValueOf: valueOf } : {}),
      Filters: filters,
    },
    AggregateOn: aggregateOn,
  });
}
