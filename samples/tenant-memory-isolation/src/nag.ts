// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * cdk-nag acknowledgment for granular findings (the helper tenant-encrypted-
 * ingestion and agentic-runtime-isolation use). `Validations.acknowledge()`
 * rejects ids with more than one `::`, which granular IAM5 ids contain, so
 * the documented metadata key is written directly.
 */

import { Stack, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Acknowledges `AwsSolutions-IAM5[Resource::<resource>]` for a resource built from `value`. */
export function acknowledgeResourceWildcard(scope: IConstruct, value: string, reason: string): void {
  const id = `AwsSolutions-IAM5[Resource::${flatten(Stack.of(scope).resolve(value))}]`;
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [id]: reason });
}

/** Renders a resolved token the way cdk-nag prints it in finding ids. */
function flatten(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  const obj = node as Record<string, unknown>;
  if (obj['Fn::Join'] !== undefined) {
    const [delimiter, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map(flatten).join(delimiter);
  }
  if (obj['Fn::GetAtt'] !== undefined) {
    const [resource, attribute] = obj['Fn::GetAtt'] as [unknown, unknown];
    return `<${flatten(resource)}.${flatten(attribute)}>`;
  }
  if (obj.Ref !== undefined) {
    return `<${flatten(obj.Ref)}>`;
  }
  return JSON.stringify(node);
}
