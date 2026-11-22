// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * cdk-nag acknowledgment helper. `Validations.of(scope).acknowledge()`
 * rejects an id containing more than one `::`, but cdk-nag's granular
 * finding ids (`AwsSolutions-IAM5[Resource::...]`) legitimately contain
 * several. cdk-nag reads acknowledgments from the documented
 * `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` construct metadata and
 * compares raw keys, so recording the metadata directly is the supported
 * escape hatch. Every acknowledgment names an ADR or a mitigation.
 */

import { Stack, Validations } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

/** Acknowledges a GRANULAR cdk-nag finding (`RuleId[FindingId]`) on a construct. */
export function acknowledgeGranularFinding(scope: IConstruct, id: string, reason: string): void {
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [id]: reason });
}

/** Acknowledges whole-rule findings on a construct. */
export function acknowledge(scope: IConstruct, id: string, reason: string): void {
  Validations.of(scope).acknowledge({ id, reason });
}

/**
 * Renders a CDK token string the way cdk-nag renders IAM policy resources in
 * granular finding ids: resolved to its CloudFormation form with intrinsics
 * flattened to `<Name>` placeholders.
 */
export function nagFindingResource(scope: IConstruct, value: string): string {
  return flatten(Stack.of(scope).resolve(value));
}

export function flatten(node: unknown): string {
  if (node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    return node.replace(/\$\{/g, '<').replace(/\}/g, '>');
  }
  const obj = node as Record<string, unknown>;
  if (obj['Fn::Join'] !== undefined) {
    const [delimiter, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map(flatten).join(delimiter);
  }
  if (obj['Fn::Sub'] !== undefined) {
    return flatten(obj['Fn::Sub']);
  }
  if (obj['Fn::GetAtt'] !== undefined) {
    const [resource, attribute] = obj['Fn::GetAtt'] as [unknown, unknown];
    return `<${flatten(resource)}.${flatten(attribute)}>`;
  }
  if (obj['Fn::ImportValue'] !== undefined) {
    return flatten(obj['Fn::ImportValue']);
  }
  if (obj.Ref !== undefined) {
    return `<${flatten(obj.Ref)}>`;
  }
  return JSON.stringify(node);
}

interface KnownWildcard {
  /** Matches the resource as cdk-nag renders it. */
  readonly matches: (resource: string) => boolean;
  /** Every action of the statement must match, so a wider action on the same resource is still a finding. */
  readonly actions: RegExp;
  readonly reason: string;
}

/** What the table needs to know about one deployment. */
export interface KnownContext {
  /** The input bucket's ARN as cdk-nag renders it (`nagFindingResource`), so a tenant prefix of another bucket stays a finding. */
  readonly inputBucket: string;
  /**
   * The log group names and prefixes the backends own (`logCleanup()`), as cdk-nag renders them. A log wildcard is
   * accepted only after one of these (`:*` or a stream part after a name, `*` or a stream part after a prefix), so
   * another group, a sibling of a name, or a whole service's groups stays a finding.
   */
  readonly logGroups: readonly string[];
  readonly logGroupPrefixes: readonly string[];
  /** ARNs of the functions the construct's own provider may invoke (`nagFindingResource`), so another function stays a finding. */
  readonly invokable: readonly string[];
}

const re = (pattern: RegExp) => (resource: string): boolean => pattern.test(resource);

/**
 * The wildcards the backends' statements and roles carry, each with the
 * reason it is accepted. A wildcard that matches none of these stays a
 * finding. The resources are this deployment's own: a cluster, a runtime,
 * a log group name or prefix, or the tenant's own prefix.
 */
export function knownWildcards(ctx: KnownContext): readonly KnownWildcard[] {
  const bucket = ctx.inputBucket;
  return [
    {
      matches: re(/^\*$/),
      actions: /^(ecr:GetAuthorizationToken|ec2:DescribeInstances|lambda:ListMicrovms|ecs:ListTasks|ecs:DiscoverPollEndpoint|logs:DescribeLogGroups)$/,
      reason: 'These actions take no resource (spec 3.6, ADR-0011, ADR-0030): ECR token, EC2 and MicroVM listing, the ECS poll endpoint, log group listing. ecs:ListTasks carries an ecs:cluster condition. None reads tenant data.',
    },
    {
      matches: re(/^\*$/),
      actions: /^ec2:(CreateNetworkInterface|DescribeNetworkInterfaces|DescribeSubnets|DeleteNetworkInterface|AssignPrivateIpAddresses|UnassignPrivateIpAddresses)$/,
      reason: 'A function in a VPC manages its own network interfaces, which have no id before they exist; these six actions are the managed VPC access policy minus its log writes, so no role here can write another function\'s log group (spec 3.6, ADR-0029).',
    },
    {
      matches: (r) => r === `${bucket}/inputs/<aws:PrincipalTag/TenantId>/*`,
      actions: /^s3:GetObject$/,
      reason: 'The wildcard is the object name under the caller\'s own inputs prefix, resolved from the TenantId session tag; the role reaches no other prefix (spec 3.6, C-5, ADR-0030).',
    },
    {
      matches: (r) => r === `${bucket}/outputs/<aws:PrincipalTag/TenantId>/*`,
      actions: /^s3:PutObject$/,
      reason: 'The wildcard is the object name under the caller\'s own outputs prefix, resolved from the TenantId session tag; the role reaches no other prefix (spec 3.6, C-5, ADR-0030).',
    },
    {
      matches: (r) => r === `${bucket}/sessions/<aws:AgentCoreRuntimeSourceSid>/*`,
      actions: /^s3:(GetObject|PutObject)$/,
      reason: 'The wildcard is the object name under the one prefix the platform derives from the session, so a session reaches only its own prefix (ADR-0007, spec 3.6 AgentCore runtime role).',
    },
    {
      // The framework function invokes the drain function, and the Lambda grant names the function with any qualifier.
      matches: (r) => ctx.invokable.some((arn) => r === `${arn}:*`),
      actions: /^lambda:InvokeFunction$/,
      reason: 'The drain custom resource\'s framework function invokes the drain function of this stack; the grant names the ARN of that function with any version or alias, and no other function (ADR-0029).',
    },
    {
      matches: re(/:network-interface\/\*$/),
      actions: /^ec2:(CreateNetworkInterface|CreateTags)$/,
      reason: 'The connector operator role creates and tags network interfaces, which have no id before creation; its subnet and security group resources are the sample\'s and CreateTags needs the managed-operator condition (spec 3.6 MicroVM connector operator role).',
    },
    {
      // A log group of a backend: after a name, `:*` or a stream part; after a prefix, `*` or a stream part. With no known group nothing matches.
      matches: (r) => {
        const at = r.indexOf(':log-group:');
        if (at < 0) return false;
        const rest = r.slice(at + ':log-group:'.length);
        return ctx.logGroups.some((n) => rest === `${n}:*` || rest === `${n}:log-stream:*`)
          || ctx.logGroupPrefixes.some((p) => rest === `${p}*` || rest === `${p}*:log-stream:*`);
      },
      actions: /^logs:(CreateLogGroup|CreateLogStream|PutLogEvents|DescribeLogStreams|DeleteLogGroup)$/,
      reason: 'The wildcard is a log stream, or the id the service appends to a runtime name; the group name or prefix before it is one the deployment\'s backends own and the log cleanup resource deletes (spec 3.6, 5.3).',
    },
    {
      // A cluster resource of this stack: a logical id ending in Cluster and its hash, not a pseudo parameter.
      matches: re(/:task\/<[^>.:]*Cluster[0-9A-F]{8}>\/\*$/),
      actions: /^ecs:(DescribeTasks|StopTask|TagResource)$/,
      reason: 'The wildcard is the task id under a cluster of this stack, which ECS assigns at run time; the statements carry the tag or cluster conditions of spec 3.6 and ADR-0014 where the action supports them.',
    },
    {
      matches: re(/:container-instance\/<[^>.:]*Cluster[0-9A-F]{8}>\/\*$/),
      actions: /^ecs:DescribeContainerInstances$/,
      reason: 'The wildcard is the container instance id under a cluster of this stack (spec 3.6 Drain role).',
    },
    {
      matches: re(/:container-instance\/\*$/),
      actions: /^ecs:(Poll|StartTelemetrySession|PutSystemLogEvents)$/,
      reason: 'The ECS agent on a managed instance polls and reports for its own instance id, which no one knows before launch; these are the actions of the ECS-written instance role (ADR-0004).',
    },
    {
      matches: re(/<[^>.:]+\.AgentRuntimeArn>\/runtime-endpoint\/\*$/),
      actions: /^bedrock-agentcore:(InvokeAgentRuntime|StopRuntimeSession)$/,
      reason: 'The wildcard is an endpoint of a runtime of this stack (spec 3.6 Tool role); no runtime outside the stack is named.',
    },
  ];
}

/** The known-wildcard entry that accepts a resource for all of a statement's actions, if any. */
export function knownWildcard(resource: string, actions: readonly string[], ctx: KnownContext): KnownWildcard | undefined {
  return knownWildcards(ctx).find((k) => k.matches(resource) && actions.length > 0 && actions.every((a) => k.actions.test(a)));
}

interface ResolvedStatement { Action?: string | string[]; Resource?: unknown }

function statementsOf(doc: unknown): ResolvedStatement[] {
  const d = doc as { Statement?: ResolvedStatement | ResolvedStatement[] } | undefined;
  if (!d?.Statement) return [];
  return Array.isArray(d.Statement) ? d.Statement : [d.Statement];
}

/**
 * Acknowledges the IAM5 findings of every statement under `root` whose
 * wildcard resource is in {@link knownWildcards}, and the other findings of
 * the backends' resources that the sample accepts (ECS cluster insights,
 * the ECS-required managed policy), each with its reason. Call it after the
 * statements are added.
 */
export function acknowledgeKnownFindings(root: IConstruct, ctx: KnownContext): void {
  const stack = Stack.of(root);
  for (const node of root.node.findAll()) {
    if (node instanceof iam.CfnPolicy) {
      acknowledgeStatements(node, statementsOf(stack.resolve(node.policyDocument)), ctx);
    } else if (node instanceof iam.CfnRole) {
      const inline = stack.resolve(node.policies) as { policyDocument?: unknown; PolicyDocument?: unknown }[] | undefined;
      acknowledgeStatements(node, (inline ?? []).flatMap((p) => statementsOf(p.policyDocument ?? p.PolicyDocument)), ctx);
      const managed = (stack.resolve(node.managedPolicyArns) as unknown[] | undefined) ?? [];
      if (managed.some((m) => flatten(m).endsWith(':iam::aws:policy/AmazonECSInfrastructureRolePolicyForManagedInstances'))) {
        acknowledgeGranularFinding(
          node,
          'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonECSInfrastructureRolePolicyForManagedInstances]',
          'ECS Managed Instances requires this AWS-managed policy on the infrastructure role; it is the service\'s documented minimum for launching and terminating the instances (ADR-0004).',
        );
      }
    } else if (node instanceof ecs.CfnCluster) {
      acknowledge(
        node,
        'AwsSolutions-ECS4',
        'Container Insights bills per task and the sandboxes are short-lived; per-tenant run and sandbox-second attribution comes from the tool line and its Contributor Insights rules (ADR-0013).',
      );
    }
  }
}

function acknowledgeStatements(target: IConstruct, statements: ResolvedStatement[], ctx: KnownContext): void {
  // One finding id per resource text, so statements that share a wildcard (`*`) share one acknowledgement:
  // it carries the reason of every known entry they match, not only the first.
  const reasons = new Map<string, string[]>();
  for (const s of statements) {
    const actions = ([] as string[]).concat(s.Action ?? []);
    for (const resource of ([] as unknown[]).concat(s.Resource ?? [])) {
      const text = flatten(resource);
      if (!text.includes('*')) continue;
      const known = knownWildcard(text, actions, ctx);
      if (!known) continue;
      const id = `AwsSolutions-IAM5[Resource::${text}]`;
      const list = reasons.get(id) ?? [];
      if (!list.includes(known.reason)) list.push(known.reason);
      reasons.set(id, list);
    }
  }
  for (const [id, list] of reasons) acknowledgeGranularFinding(target, id, list.join(' '));
}

const copyAcknowledged = new WeakSet<Stack>();

/** Memory of the image copy function. It is not the library's default or a round size, so the function (and its role) is the construct's alone unless an app picks the same number (ADR-0029). */
export const IMAGE_COPY_MEMORY_MIB = 1088;

/**
 * The image copy library puts one Lambda in the stack for every memory size.
 * The construct asks for its own size, so the function is its alone. The
 * role holds the library's policy: ECR read and write and `s3:GetObject` on
 * every resource, and the basic execution policy (log writes on every
 * group). The construct denies ECR writes outside the runner repositories,
 * every S3 action on the input buckets and `logs:CreateLogGroup`, and points
 * the function at a log group it owns (ADR-0029). `s3:GetObject` on other
 * buckets and log writes to other groups remain.
 */
export function acknowledgeImageCopy(stack: Stack): void {
  if (copyAcknowledged.has(stack)) return;
  copyAcknowledged.add(stack);
  for (const child of stack.node.children.filter((c) => c.node.id.startsWith('Custom::CDKECRDeployment') && c.node.id.endsWith(`${IMAGE_COPY_MEMORY_MIB}MiB`))) {
    const role = child.node.findChild('ServiceRole');
    acknowledgeGranularFinding(
      role,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'The managed policy allows CreateLogStream and PutLogEvents on every log group; CreateLogGroup is denied on the role and the function writes to a group the construct owns. The function runs at deploy and destroy time only (ADR-0029).',
    );
    acknowledgeGranularFinding(
      role,
      'AwsSolutions-IAM5[Resource::*]',
      'Blanket acknowledgement of Resource::* on this role, which holds the copy library\'s own policy: ECR read and write and s3:GetObject on every resource. The construct denies ECR writes outside the runner repositories, every S3 action on the input buckets and logs:CreateLogGroup; s3:GetObject on other buckets remains, because the library needs the CDK asset bucket and repository, whose names are not known here. The function runs at deploy and destroy time only and handles the runner image (ADR-0024, ADR-0029).',
    );
  }
}

/**
 * CloudFormation takes `ServiceTimeout` as a number of seconds; CDK writes
 * it as a string and CloudFormation coerces it. Every custom resource of
 * the construct sets one, a little above its function timeout, so a function
 * that cannot start never holds a delete for the default hour (spec 5.3).
 */
export function acknowledgeServiceTimeout(resource: IConstruct): void {
  acknowledge(
    resource,
    'CloudFormation-Validate::W9003',
    'CloudFormation takes ServiceTimeout as a number of seconds; CDK writes a string and CloudFormation coerces it. The value is just above the function timeout, so a function that cannot start never holds the delete for the default hour (spec 5.3).',
  );
}
