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

/** Read-only grant on both shared namespaces — the account-wide `/application-plane/shared/*` and every application's `/application-plane/applications/*` (both roles, ADR-034, ADR-038). */
export function readSharedResourcesStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ReadSharedResources',
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    resources: [
      ssmParameterArn(scope, '/application-plane/shared/*'),
      ssmParameterArn(scope, '/application-plane/applications/*'),
    ],
  });
}

/**
 * The build session's own cell namespace, `/application-plane/cells/<cellId>`,
 * named by the session's `CellId` tag (ADR-0051). IAM resolves the policy
 * variable per request; a session without the tag matches nothing.
 */
export const OWN_CELL_PATH = '/application-plane/cells/${aws:PrincipalTag/CellId}';

/**
 * The build session's own deployment namespace,
 * `/application-plane/tenants/<tenantId>/<applicationId>` (ADR-037), named by
 * the session's `TenantId` and `ApplicationId` tags (ADR-0051).
 */
export const OWN_DEPLOYMENT_PATH = '/application-plane/tenants/${aws:PrincipalTag/TenantId}/${aws:PrincipalTag/ApplicationId}';

/** A tagged namespace and everything under it: the path itself is a parameter or a `GetParametersByPath` path. */
function namespaceArns(scope: Construct, path: string): string[] {
  return [ssmParameterArn(scope, path), ssmParameterArn(scope, `${path}/*`)];
}

/** Read + write/delete on the session's own cell namespace (the cell role only, ADR-0051). */
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
    resources: namespaceArns(scope, OWN_CELL_PATH),
  });
}

/** Read-only on the session's own cell namespace (the tenant role: it reads its cell's identifiers, ADR-0051). */
export function readCellNamespaceStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ReadCellNamespace',
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    resources: namespaceArns(scope, OWN_CELL_PATH),
  });
}

/** Read + write/delete on the session's own deployment namespace (the tenant role only, ADR-0051). */
export function manageTenantNamespaceStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ManageTenantNamespace',
    actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
    resources: namespaceArns(scope, OWN_DEPLOYMENT_PATH),
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

/**
 * Acknowledges the AwsSolutions-IAM5 finding for the `/*` under a namespace
 * named by session tags ({@link OWN_CELL_PATH}, {@link OWN_DEPLOYMENT_PATH}).
 */
export function acknowledgeTaggedSsmGrant(scope: Construct, taggedPath: string): void {
  acknowledgeGranularFinding(
    scope,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, ssmParameterArn(scope, `${taggedPath}/*`))}]`,
    `The wildcard covers the parameters under the build session's own namespace '${taggedPath}' only: the path is named by the session's transitive tags, which the control plane sets and the pair's trust requires (ADR-0051, ADR-010). A session without the tags matches nothing.`,
  );
}
