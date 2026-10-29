// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * cdk-nag acknowledgment helpers (the same two tenant-identity uses).
 * `Validations.of(scope).acknowledge()` rejects an id containing more than
 * one `::`, but cdk-nag's granular finding ids (`AwsSolutions-IAM5[Resource::
 * ...]`) legitimately contain several. cdk-nag reads acknowledgments from the
 * documented `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` construct metadata
 * and compares raw keys, so recording the metadata directly is the supported
 * escape hatch.
 */

import { Stack, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Acknowledges a GRANULAR cdk-nag finding (`RuleId[FindingId]`) on a construct. */
export function acknowledgeGranularFinding(scope: IConstruct, id: string, reason: string): void {
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [id]: reason });
}

/**
 * Renders a CDK token string the way cdk-nag renders IAM policy resources in
 * granular finding ids: resolved to its CloudFormation form with intrinsics
 * flattened to `<Name>` placeholders. Building the id from the SAME token
 * that produced the policy resource keeps it correct in any account, Region
 * or partition.
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
