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
  readonly resource: RegExp;
  /** Every action of the statement must match, so a wider action on the same resource is still a finding. */
  readonly actions: RegExp;
  readonly reason: string;
}

/**
 * The wildcards the backends' statements and roles carry, each with the
 * reason it is accepted. A wildcard that matches none of these stays a
 * finding. The resources are this deployment's own: a cluster, a runtime,
 * a log group name or prefix, or the tenant's own prefix.
 */
export const KNOWN_WILDCARDS: readonly KnownWildcard[] = [
  {
    resource: /^\*$/,
    actions: /^(ecr:GetAuthorizationToken|ec2:DescribeInstances|lambda:ListMicrovms|ecs:ListTasks|ecs:DiscoverPollEndpoint|logs:DescribeLogGroups)$/,
    reason: 'These actions take no resource (spec 3.6, ADR-0011, ADR-0051): ECR token, EC2 and MicroVM listing, the ECS poll endpoint, log group listing. ecs:ListTasks carries an ecs:cluster condition. None reads tenant data.',
  },
  {
    resource: /^<[^>]*>\/(inputs|outputs)\/<aws:PrincipalTag\/TenantId>\/\*$/,
    actions: /^s3:(GetObject|PutObject)$/,
    reason: 'The wildcard is the object name under the caller\'s own prefix, resolved from the TenantId session tag; the role reaches no other prefix (spec 3.6, C-5, ADR-0030).',
  },
  {
    resource: /:network-interface\/\*$/,
    actions: /^ec2:(CreateNetworkInterface|CreateTags)$/,
    reason: 'The connector operator role creates and tags network interfaces, which have no id before creation; its subnet and security group resources are the sample\'s and CreateTags needs the managed-operator condition (spec 3.6 MicroVM connector operator role).',
  },
  {
    resource: /:log-group:[^ ]*(\*|:\*)$/,
    actions: /^logs:(CreateLogGroup|CreateLogStream|PutLogEvents|DescribeLogStreams|DeleteLogGroup)$/,
    reason: 'The wildcard is a log stream, or the id the service appends to a runtime or image group name; the group name or prefix is this deployment\'s own (spec 3.6, 5.3).',
  },
  {
    resource: /:(task|container-instance)\/(<[^>]*>\/)?\*$/,
    actions: /^ecs:(DescribeTasks|StopTask|TagResource|DescribeContainerInstances|Poll|StartTelemetrySession|PutSystemLogEvents)$/,
    reason: 'The wildcard is the task or container instance id under this deployment\'s own cluster, which ECS assigns at run time; the statements carry the tag or cluster conditions of spec 3.6 and ADR-0014 where the action supports them.',
  },
  {
    resource: /<[^>]*\.AgentRuntimeArn>\/runtime-endpoint\/\*$/,
    actions: /^bedrock-agentcore:(InvokeAgentRuntime|StopRuntimeSession)$/,
    reason: 'The wildcard is an endpoint of this deployment\'s own runtime (ADR-0050); no other runtime is named.',
  },
];

/** The known-wildcard entry that accepts a resource for all of a statement's actions, if any. */
export function knownWildcard(resource: string, actions: readonly string[]): KnownWildcard | undefined {
  return KNOWN_WILDCARDS.find((k) => k.resource.test(resource) && actions.length > 0 && actions.every((a) => k.actions.test(a)));
}

interface ResolvedStatement { Action?: string | string[]; Resource?: unknown }

function statementsOf(doc: unknown): ResolvedStatement[] {
  const d = doc as { Statement?: ResolvedStatement | ResolvedStatement[] } | undefined;
  if (!d?.Statement) return [];
  return Array.isArray(d.Statement) ? d.Statement : [d.Statement];
}

/**
 * Acknowledges the IAM5 findings of every statement under `root` whose
 * wildcard resource is in {@link KNOWN_WILDCARDS}, and the other findings of
 * the backends' resources that the sample accepts (ECS cluster insights,
 * the ECS-required managed policy), each with its reason. Call it after the
 * statements are added.
 */
export function acknowledgeKnownFindings(root: IConstruct): void {
  const stack = Stack.of(root);
  for (const node of root.node.findAll()) {
    if (node instanceof iam.CfnPolicy) {
      acknowledgeStatements(node, statementsOf(stack.resolve(node.policyDocument)));
    } else if (node instanceof iam.CfnRole) {
      const inline = stack.resolve(node.policies) as { policyDocument?: unknown; PolicyDocument?: unknown }[] | undefined;
      acknowledgeStatements(node, (inline ?? []).flatMap((p) => statementsOf(p.policyDocument ?? p.PolicyDocument)));
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

function acknowledgeStatements(target: IConstruct, statements: ResolvedStatement[]): void {
  for (const s of statements) {
    const actions = ([] as string[]).concat(s.Action ?? []);
    for (const resource of ([] as unknown[]).concat(s.Resource ?? [])) {
      const text = flatten(resource);
      if (!text.includes('*')) continue;
      const known = knownWildcard(text, actions);
      if (known) acknowledgeGranularFinding(target, `AwsSolutions-IAM5[Resource::${text}]`, known.reason);
    }
  }
}

const copyAcknowledged = new WeakSet<Stack>();

/**
 * The image copy library puts one Lambda in the stack for every copy. Its
 * role holds the library's own policy: Lambda basic execution, and ECR and
 * S3 read actions on `*`. It runs at deploy time only and handles no
 * tenant data (ADR-0024, ADR-0032).
 */
export function acknowledgeImageCopy(stack: Stack): void {
  if (copyAcknowledged.has(stack)) return;
  copyAcknowledged.add(stack);
  for (const child of stack.node.children.filter((c) => c.node.id.startsWith('Custom::CDKECRDeployment'))) {
    const role = child.node.findChild('ServiceRole');
    acknowledgeGranularFinding(
      role,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'The managed policy is the logs-only execution policy of the copy function, which runs at deploy time (ADR-0024, ADR-0032).',
    );
    acknowledgeGranularFinding(
      role,
      'AwsSolutions-IAM5[Resource::*]',
      'The copy library asks for ECR and S3 read actions on every resource, because the source image and its layers are in the CDK asset repository and bucket; the function runs at deploy time only and handles no tenant data (ADR-0024, ADR-0032).',
    );
  }
}
