// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The read-only leftover check (spec §8 `teardown`). It lists what a run
 * left in the account: stacks, log groups, task definitions, clusters and
 * container instances, MicroVMs, runtimes, VPCs and endpoints, DNS Firewall
 * resources, and Logs resource policies that changed. It deletes nothing, and
 * it is used twice: by the `teardown` step after the stack delete, and by
 * `scripts/leftovers.sh` by hand after an interruption.
 *
 * Without a state file (no run on this machine) it can only list stacks by
 * prefix; with one, it looks for exactly what that run owned.
 */

import { createHash } from 'node:crypto';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeResourcePoliciesCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeVpcEndpointsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import { DescribeClustersCommand, DescribeTaskDefinitionCommand, ListContainerInstancesCommand } from '@aws-sdk/client-ecs';
import { ListMicrovmsCommand } from '@aws-sdk/client-lambda-microvms';
import { type Aws } from './aws';
import { type RunState } from './state';

export interface Finding {
  readonly kind: string;
  readonly id: string;
  readonly detail: string;
  /** True for the one leftover the spec names as known (a statement of a shared Logs resource policy, §3.9). */
  readonly known?: boolean;
}

const digest = (doc: string): string => createHash('sha256').update(doc).digest('hex').slice(0, 16);

/** The account's Logs resource policies, name to document digest. */
export async function policySnapshot(aws: Aws): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let token: string | undefined;
  do {
    const r = await aws.logs.send(new DescribeResourcePoliciesCommand({ nextToken: token }));
    for (const p of r.resourcePolicies ?? []) if (p.policyName) out[p.policyName] = digest(p.policyDocument ?? '');
    token = r.nextToken;
  } while (token);
  return out;
}

/** True when `document` names the log group `arn` (a CDK `logGroupArn` ends in `:*`; a delivery grant names the group, a stream or `:*`). */
export function namesLogGroup(document: string, arn: string): boolean {
  const base = arn.replace(/:\*$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?=[:"\\\\]|$)`).test(document);
}

/**
 * A run that stopped before the stack's resources were recorded has no query-log group ARN to look for, so any
 * policy that did not exist before the run is reported (it may be the stack's own). Pure.
 */
export function newPolicyFindings(baseline: Readonly<Record<string, string>>, current: ReadonlyArray<{ name: string; document: string }>): Finding[] {
  const findings: Finding[] = [];
  for (const p of current) {
    if (baseline[p.name] === undefined) {
      findings.push({ kind: 'logs-resource-policy', id: p.name, detail: 'a policy that did not exist before the run (the run stopped before its resources were recorded)' });
    } else if (baseline[p.name] !== digest(p.document)) {
      findings.push({ kind: 'logs-resource-policy', id: p.name, detail: 'a shared policy differs from its state before the run', known: true });
    }
  }
  return findings;
}

/**
 * Policies that name the run's query-log group. The construct's own policy
 * (one of the stack's resources) is a plain leftover; a statement in any other
 * policy, shared or created by delivery during the run, is the known leftover
 * of C-6 (spec §3.9). Pure, so a unit test covers it.
 */
export function policyFindings(
  baseline: Readonly<Record<string, string>>,
  current: ReadonlyArray<{ name: string; document: string }>,
  queryLogGroupArn: string | undefined,
  ownPolicyNames: ReadonlySet<string> = new Set(),
): Finding[] {
  const findings: Finding[] = [];
  for (const p of current) {
    if (queryLogGroupArn === undefined || !namesLogGroup(p.document, queryLogGroupArn)) continue;
    findings.push(ownPolicyNames.has(p.name)
      ? { kind: 'logs-resource-policy', id: p.name, detail: 'a Logs resource policy of the stack is still there' }
      : { kind: 'logs-resource-policy', id: p.name, detail: `a statement naming the query-log group stays in a shared policy${baseline[p.name] === undefined ? ' that delivery created' : ''}`, known: true });
  }
  return findings;
}

async function exists<T>(fn: () => Promise<T>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (/ResourceNotFoundException|NotFoundException|ClusterNotFoundException/.test(name) || (e instanceof Error && /InvalidVpcID\.NotFound|InvalidVpcEndpointId\.NotFound|ResourceNotFoundException|does not exist/i.test(e.message))) return false;
    throw e;
  }
}

/**
 * The log group prefixes of the groups AgentCore and Lambda create for the run's runtimes and MicroVM images.
 * A blank name has no prefix (undefined): listing with it would match groups the run does not own. Pure.
 */
export function serviceLogPrefixes(state: Pick<RunState, 'runtimeNames' | 'imageNames'>): Array<{ kind: 'runtime' | 'image'; prefix?: string }> {
  const blank = (n: string): boolean => n.trim() === '';
  return [
    ...state.runtimeNames.map((n) => ({ kind: 'runtime' as const, prefix: blank(n) ? undefined : `/aws/bedrock-agentcore/runtimes/${n}-` })),
    ...state.imageNames.map((n) => ({ kind: 'image' as const, prefix: blank(n) ? undefined : `/aws/lambda-microvms/${n}` })),
  ];
}

async function logGroupsWithPrefix(aws: Aws, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await aws.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken: token }));
    for (const g of r.logGroups ?? []) if (g.logGroupName) names.push(g.logGroupName);
    token = r.nextToken;
  } while (token);
  return names;
}

/** Looks for everything the run owned, and for stacks with the prefix. Read-only. */
export async function checkLeftovers(aws: Aws, prefix: string, state: RunState | undefined): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (kind: string, id: string, detail: string): void => void findings.push({ kind, id, detail });

  // Stacks, including any in DELETE_FAILED.
  let token: string | undefined;
  do {
    const r = await aws.cfn.send(new DescribeStacksCommand({ NextToken: token }));
    for (const s of r.Stacks ?? []) {
      if (s.StackName?.startsWith(prefix) && s.StackStatus !== 'DELETE_COMPLETE') add('stack', s.StackName, s.StackStatus ?? 'unknown');
    }
    token = r.NextToken;
  } while (token);
  if (!state) return findings;

  for (const r of state.resources) {
    try {
      switch (r.type) {
        case 'AWS::Logs::LogGroup':
          if ((await logGroupsWithPrefix(aws, r.physicalId)).includes(r.physicalId)) add('log-group', r.physicalId, 'still there');
          break;
        case 'AWS::ECS::Cluster': {
          const d = await aws.ecs.send(new DescribeClustersCommand({ clusters: [r.physicalId] }));
          if (d.clusters?.some((c) => c.status === 'ACTIVE')) add('ecs-cluster', r.physicalId, 'ACTIVE');
          const ci = await aws.ecs.send(new ListContainerInstancesCommand({ cluster: r.physicalId })).catch(() => undefined);
          if ((ci?.containerInstanceArns?.length ?? 0) > 0) add('container-instance', r.physicalId, `${ci?.containerInstanceArns?.length} registered`);
          break;
        }
        case 'AWS::ECS::TaskDefinition': {
          const d = await aws.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: r.physicalId })).catch(() => undefined);
          if (d?.taskDefinition?.status === 'ACTIVE') add('task-definition', r.physicalId, 'ACTIVE (a task definition cannot be deleted; deregister it)');
          break;
        }
        case 'AWS::EC2::VPC':
          if (await exists(async () => (await aws.ec2.send(new DescribeVpcsCommand({ VpcIds: [r.physicalId] }))).Vpcs?.[0] ?? Promise.reject(new Error('does not exist')))) add('vpc', r.physicalId, 'still there');
          break;
        case 'AWS::EC2::VPCEndpoint':
          if (await exists(async () => (await aws.ec2.send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: [r.physicalId] }))).VpcEndpoints?.[0] ?? Promise.reject(new Error('does not exist')))) add('vpc-endpoint', r.physicalId, 'still there');
          break;
        case 'AWS::BedrockAgentCore::Runtime':
          if (await exists(() => aws.agentcoreControl.send(new GetAgentRuntimeCommand({ agentRuntimeId: r.physicalId.split('/').pop() ?? r.physicalId })))) add('runtime', r.physicalId, 'still there');
          break;
        case 'AWS::Lambda::MicrovmImage': {
          const live = await aws.microvms.send(new ListMicrovmsCommand({ imageIdentifier: r.physicalId })).catch(() => undefined);
          for (const m of live?.items ?? []) if (m.state !== 'TERMINATED') add('microvm', m.microvmId ?? r.physicalId, String(m.state));
          break;
        }
        case 'AWS::Route53Resolver::FirewallRuleGroup':
          if (await exists(() => aws.cli(['route53resolver', 'get-firewall-rule-group', '--firewall-rule-group-id', r.physicalId]))) add('dns-firewall-rule-group', r.physicalId, 'still there');
          break;
        case 'AWS::Route53Resolver::FirewallDomainList':
          if (await exists(() => aws.cli(['route53resolver', 'get-firewall-domain-list', '--firewall-domain-list-id', r.physicalId]))) add('dns-firewall-domain-list', r.physicalId, 'still there');
          break;
        case 'AWS::Route53Resolver::ResolverQueryLoggingConfig':
          if (await exists(() => aws.cli(['route53resolver', 'get-resolver-query-log-config', '--resolver-query-log-config-id', r.physicalId]))) add('dns-query-log-config', r.physicalId, 'still there');
          break;
        case 'AWS::Route53Resolver::FirewallRuleGroupAssociation':
          if (await exists(() => aws.cli(['route53resolver', 'get-firewall-rule-group-association', '--firewall-rule-group-association-id', r.physicalId]))) add('dns-firewall-association', r.physicalId, 'still there');
          break;
        case 'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation':
          if (await exists(() => aws.cli(['route53resolver', 'get-resolver-query-log-config-association', '--resolver-query-log-config-association-id', r.physicalId]))) add('dns-query-log-association', r.physicalId, 'still there');
          break;
        default:
          break;
      }
    } catch (e) {
      add('check-failed', `${r.type}:${r.physicalId}`, e instanceof Error ? e.name : 'error');
    }
  }
  // Log groups the services create after the deploy. An empty name would widen the prefix to every such group of
  // the account (or be refused by the API), so it is reported instead of listed.
  for (const p of serviceLogPrefixes(state)) {
    if (p.prefix === undefined) {
      add('check-failed', p.kind, 'an empty service name in the run state; its log groups were not checked');
      continue;
    }
    for (const g of await logGroupsWithPrefix(aws, p.prefix)) add('log-group', g, `${p.kind === 'runtime' ? 'an AgentCore runtime' : 'a MicroVM image'} group is still there`);
  }

  // The Logs resource policies, compared with the state before the deploy.
  const current: Array<{ name: string; document: string }> = [];
  let pt: string | undefined;
  do {
    const r = await aws.logs.send(new DescribeResourcePoliciesCommand({ nextToken: pt }));
    for (const p of r.resourcePolicies ?? []) if (p.policyName) current.push({ name: p.policyName, document: p.policyDocument ?? '' });
    pt = r.nextToken;
  } while (pt);
  if (state.resources.length === 0) {
    findings.push(...newPolicyFindings(state.policyBaseline, current));
  } else {
    const own = state.resources.filter((r) => r.type === 'AWS::Logs::ResourcePolicy').map((r) => r.physicalId);
    findings.push(...policyFindings(state.policyBaseline, current, state.queryLogGroupArn, new Set(own)));
  }
  return findings;
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'nothing left';
  return findings.map((f) => `${f.known ? 'known leftover' : 'LEFT'} ${f.kind} ${f.id}: ${f.detail}`).join('\n');
}
