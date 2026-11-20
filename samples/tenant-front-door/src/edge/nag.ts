// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * cdk-nag acknowledgment helpers (the ones `agentic-runtime-isolation`
 * and `tenant-identity` use). `Validations.of(scope).acknowledge()` rejects
 * an id with more than one `::`, but cdk-nag's granular finding ids
 * (`AwsSolutions-IAM5[Resource::...]`) contain several. cdk-nag reads the
 * documented `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` metadata and
 * compares raw keys, so recording it directly is the supported escape hatch.
 */

import { Stack, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Acknowledges a rule (`AwsSolutions-S1`) or a granular finding (`RuleId[FindingId]`) on a construct and its children. */
export function acknowledge(scope: IConstruct, id: string, reason: string): void {
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [id]: reason });
}

/**
 * Renders a CDK token the way cdk-nag renders IAM policy resources in
 * granular finding ids: resolved, with intrinsics flattened to `<Name>`.
 * Building the id from the same token keeps it right in any account,
 * Region or partition.
 */
export function nagFindingResource(scope: IConstruct, value: string): string {
  return flatten(Stack.of(scope).resolve(value));
}

function flatten(node: unknown): string {
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

/** The managed policy every NodejsFunction here attaches. */
export const BASIC_EXECUTION_ROLE_FINDING =
  'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]';
