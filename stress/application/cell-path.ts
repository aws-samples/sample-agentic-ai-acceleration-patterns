// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What a cell app applies so its stacks deploy through the cell bootstrap (spec §8,
 * decision 7; stress ADR-0006, ADR-0011): every role on `/cell/`, the `cell` qualifier,
 * and the workload boundary on every role. The W-5 cell script uses both.
 */

import { Aspects, CfnResource, type IAspect } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { CELL_QUALIFIER, CELL_ROLE_PATH, type CellPolicyNames } from './cell-policies';

/**
 * Puts every `AWS::IAM::Role` on the cell role path. It matches the CloudFormation type,
 * not `CfnRole`, so custom resource provider roles (raw `CfnResource`s) move too, and it
 * sets `Path` with a property override, which wins over any path a construct set.
 * Roles are named by `Fn::GetAtt`, so no ARN breaks; code that builds a role ARN by
 * name (`Role.fromRoleName`) must add the path.
 */
export class CellRolePath implements IAspect {
  visit(node: IConstruct): void {
    if (CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::IAM::Role') {
      node.addPropertyOverride('Path', CELL_ROLE_PATH);
    }
  }
}

/** Applies {@link CellRolePath} to a scope (an app, a stage or a stack). */
export function applyCellRolePath(scope: IConstruct): void {
  Aspects.of(scope).add(new CellRolePath());
}

/**
 * The context a cell app synthesises with. It must reach the CDK as an object
 * (`new App({ context })`, `cdk.json`, `cdk.context.json` or `CDK_CONTEXT_JSON`): a CLI
 * `--context` passes the boundary as a string, which the CDK ignores (boundary spike B-1).
 */
export function cellSynthContext(names: CellPolicyNames): Record<string, unknown> {
  return {
    '@aws-cdk/core:bootstrapQualifier': CELL_QUALIFIER,
    '@aws-cdk/core:permissionsBoundary': { name: names.workloadBoundary },
  };
}
