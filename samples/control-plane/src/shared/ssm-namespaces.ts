// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ArnFormat, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { acknowledgeGranularFinding, nagFindingResource } from './nag';

/**
 * The parameter namespace contract (spec §6.2, ADR-010): the three
 * `/application-plane/*` namespaces an account's provisioning role pair may
 * read or own. Every namespace lives in the account that hosts the cell;
 * these helpers build the grants for that account's roles (ADR-025).
 */

/** Read-only grant on `/application-plane/shared/*` (both roles). */
export function readSharedResourcesStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ReadSharedResources',
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    resources: [ssmParameterArn(scope, '/application-plane/shared/*')],
  });
}

/** Read + write/delete on `/application-plane/cells/*` (the cell role only). */
export function manageCellNamespaceStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ManageCellNamespace',
    actions: [
      'ssm:GetParameter',
      'ssm:GetParameters',
      'ssm:GetParametersByPath',
      'ssm:PutParameter',
      'ssm:DeleteParameter',
      'ssm:AddTagsToResource',
    ],
    resources: [ssmParameterArn(scope, '/application-plane/cells/*')],
  });
}

/** Read-only on `/application-plane/cells/*` (the tenant role: it reads its cell's identifiers). */
export function readCellNamespaceStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ReadCellNamespace',
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    resources: [ssmParameterArn(scope, '/application-plane/cells/*')],
  });
}

/** Read + write/delete on `/application-plane/tenants/*` (the tenant role only). */
export function manageTenantNamespaceStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ManageTenantNamespace',
    actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
    resources: [ssmParameterArn(scope, '/application-plane/tenants/*')],
  });
}

/** ARN of an SSM parameter path in the scope's own account and Region. */
export function ssmParameterArn(scope: Construct, path: string): string {
  return Stack.of(scope).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: path.replace(/^\//, ''),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/**
 * Acknowledges the AwsSolutions-IAM5 finding for a prefix-scoped SSM
 * parameter grant. Prefix-scoped parameter namespaces ARE the isolation
 * contract between the control plane and provisioning scripts (ADR-010):
 * the wildcard is the namespace boundary, not an over-grant.
 */
export function acknowledgeSsmNamespaceGrant(scope: Construct, parameterPath: string): void {
  acknowledgeGranularFinding(
    scope,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, ssmParameterArn(scope, parameterPath))}]`,
    `Prefix-scoped parameter namespace '${parameterPath}' is the ADR-010 contract between the control plane and provisioning scripts - the wildcard is the namespace boundary.`,
  );
}
