// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Aws, RemovalPolicy } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as r53r from 'aws-cdk-lib/aws-route53resolver';
import { Construct } from 'constructs';
import type { NameFor } from '../backend-construct';

/** The names the firewall always allows (spec §3.9, ADR-0016). */
export const DNS_FIREWALL_ALLOWED_DOMAINS: readonly string[] = [
  'amazonaws.com',
  '*.amazonaws.com',
  '*.on.aws',
  '*.api.aws',
  'time.aws.com',
  '*.compute.internal',
];

export const ALLOW_PRIORITY = 100;
export const BLOCK_PRIORITY = 200;

export interface DnsFirewallProps {
  readonly vpc: ec2.IVpc;
  readonly allowDomains: readonly string[];
  readonly nameFor: NameFor;
}

/**
 * Route 53 Resolver DNS Firewall for the construct's own VPC (spec §3.9,
 * ADR-0016): ALLOW the AWS names, BLOCK everything else with NXDOMAIN, log
 * every query to a log group the construct owns, and own the Logs resource
 * policy that lets query-log delivery write there. `FirewallFailOpen` is
 * left at its default, `DISABLED`: a firewall fault blocks lookups.
 */
export class DnsFirewall extends Construct {
  public readonly queryLogGroup: logs.LogGroup;
  public readonly ruleGroup: r53r.CfnFirewallRuleGroup;
  public readonly association: r53r.CfnFirewallRuleGroupAssociation;
  public readonly queryLogConfig: r53r.CfnResolverQueryLoggingConfig;
  public readonly queryLogAssociation: r53r.CfnResolverQueryLoggingConfigAssociation;
  public readonly resourcePolicy: logs.CfnResourcePolicy;

  public constructor(scope: Construct, id: string, props: DnsFirewallProps) {
    super(scope, id);
    const { nameFor } = props;

    const allow = new r53r.CfnFirewallDomainList(this, 'AllowList', {
      name: nameFor('resolver', 'dns-allow-list'),
      domains: [...DNS_FIREWALL_ALLOWED_DOMAINS, ...props.allowDomains],
    });
    const block = new r53r.CfnFirewallDomainList(this, 'BlockList', {
      name: nameFor('resolver', 'dns-block-list'),
      domains: ['*'],
    });
    this.ruleGroup = new r53r.CfnFirewallRuleGroup(this, 'RuleGroup', {
      name: nameFor('resolver', 'dns-rule-group'),
      firewallRules: [
        {
          action: 'ALLOW',
          priority: ALLOW_PRIORITY,
          firewallDomainListId: allow.attrId,
        },
        {
          action: 'BLOCK',
          blockResponse: 'NXDOMAIN',
          priority: BLOCK_PRIORITY,
          firewallDomainListId: block.attrId,
        },
      ],
    });
    this.association = new r53r.CfnFirewallRuleGroupAssociation(this, 'Association', {
      name: nameFor('resolver', 'dns-association'),
      firewallRuleGroupId: this.ruleGroup.attrId,
      vpcId: props.vpc.vpcId,
      // The VPC holds only this construct's resources, so the first slot is free (spec §3.9 "Scope").
      priority: 101,
      // Off, so a stack delete can remove the association.
      mutationProtection: 'DISABLED',
    });

    // Named outside /aws/vendedlogs/, so delivery grants on this group's ARN and never on the prefix's shared wildcard.
    this.queryLogGroup = new logs.LogGroup(this, 'QueryLogs', {
      logGroupName: nameFor('log-group', 'dns-query-log'),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The construct's own policy, named from its path. It never writes the account's shared policy, which a
    // deploy would overwrite and a delete would remove (spec §3.9).
    this.resourcePolicy = new logs.CfnResourcePolicy(this, 'DeliveryPolicy', {
      policyName: nameFor('logs-resource-policy', 'dns-query-log'),
      policyDocument: JSON.stringify(
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AllowQueryLogDelivery',
            principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [this.queryLogGroup.logGroupArn],
            conditions: {
              StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
              ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
            },
          })],
        }).toJSON(),
      ),
    });
    this.resourcePolicy.node.addDependency(this.queryLogGroup);

    this.queryLogConfig = new r53r.CfnResolverQueryLoggingConfig(this, 'QueryLogConfig', {
      name: nameFor('resolver', 'dns-query-log'),
      destinationArn: this.queryLogGroup.logGroupArn,
    });
    // The grant exists before delivery starts and outlives it on delete (spec §3.9).
    this.queryLogConfig.node.addDependency(this.resourcePolicy);
    this.queryLogAssociation = new r53r.CfnResolverQueryLoggingConfigAssociation(this, 'QueryLogAssociation', {
      resolverQueryLogConfigId: this.queryLogConfig.attrId,
      resourceId: props.vpc.vpcId,
    });
    this.queryLogAssociation.node.addDependency(this.resourcePolicy);
  }
}
