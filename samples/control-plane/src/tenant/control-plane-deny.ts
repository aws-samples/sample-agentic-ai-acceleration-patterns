// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as iam from 'aws-cdk-lib/aws-iam';
import {
  apiRoleArn,
  buildProjectArn,
  BUILD_PROJECT_KINDS,
  buildRoleArn,
  hookRoleArn,
  provisioningRoleArn,
  workflowArn,
  workflowExecutionArnPattern,
} from '../shared/fleet';

/**
 * The explicit deny of spec R-41 (ADR-044, M30, T41): the actions that lead
 * from a role to the provisioning build roles, and through them to the pair of
 * every registered account, or that remove the deny itself. Attached to the
 * six roles that run deployer-attachable policies or run tenant-controlled
 * scripts: the two build roles, the two hook roles and the two pair roles of
 * the stack's own account.
 *
 * This file builds the statements only. The stack puts them in ONE standalone
 * `AWS::IAM::Policy`, outside every role construct, attached through its
 * `Roles` list, so nothing depends on it: in a role's default policy it would
 * close a CloudFormation cycle, because the home pair depends on every child
 * of the build role constructs and the deny names the home pair.
 */

/** What the deny names. Physical names are computed from the fleet name; the rest are attributes of resources the policy may reference because nothing references the policy. */
export interface ControlPlaneDenyTargets {
  readonly partition: string;
  readonly region: string;
  readonly account: string;
  readonly fleetName: string;
  /** The workflow's role, CDK-generated name (an attribute). */
  readonly workflowRoleArn: string;
  /** The authorizer function's role, CDK-generated name (an attribute). */
  readonly authorizerRoleArn: string;
  /** The API Gateway CloudWatch role, CDK-generated name (an attribute); absent when the stack creates none. */
  readonly apiGatewayCloudWatchRoleArn?: string;
  /** Unqualified ARN of the API function; the qualified form is this plus `:*`. */
  readonly apiFunctionArn: string;
  /** Unqualified ARN of the authorizer function. */
  readonly authorizerFunctionArn: string;
  readonly restApiId: string;
  readonly tableArn: string;
}

/** The seven IAM role writes denied on every role the stack creates. */
export const DENIED_IAM_ROLE_WRITES = [
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePermissionsBoundary',
  'iam:DeleteRolePermissionsBoundary',
] as const;

/** The six CodeBuild actions denied on all four projects. */
export const DENIED_CODEBUILD_ACTIONS = [
  'codebuild:StartBuild',
  'codebuild:StartBuildBatch',
  'codebuild:RetryBuild',
  'codebuild:UpdateProject',
  'codebuild:CreateWebhook',
  'codebuild:UpdateWebhook',
] as const;

/** The six Lambda writes denied on the API and authorizer functions. */
export const DENIED_LAMBDA_WRITES = [
  'lambda:UpdateFunctionCode',
  'lambda:UpdateFunctionConfiguration',
  'lambda:PublishVersion',
  'lambda:CreateAlias',
  'lambda:UpdateAlias',
  'lambda:DeleteAlias',
] as const;

/** The four invoke and permission actions denied on the API function (InvokeAsync is the deprecated asynchronous invoke, an action of its own). */
export const DENIED_LAMBDA_API_ACTIONS = [
  'lambda:InvokeFunction',
  'lambda:InvokeAsync',
  'lambda:AddPermission',
  'lambda:RemovePermission',
] as const;

/** The four API Gateway writes denied on the REST API and its sub-resources. */
export const DENIED_APIGATEWAY_ACTIONS = [
  'apigateway:PUT',
  'apigateway:PATCH',
  'apigateway:POST',
  'apigateway:DELETE',
] as const;

/**
 * The seven table writes. `TransactWriteItems` and `ExecuteTransaction` are
 * authorised per item through these, so they need no entry of their own.
 */
export const DENIED_DYNAMODB_WRITES = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:PartiQLInsert',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
] as const;

/** Both forms of a function ARN: Lambda matches a request that names a qualifier only against `function:<name>:*` (R-41). */
function bothForms(functionArn: string): string[] {
  return [functionArn, `${functionArn}:*`];
}

/** The nine Deny statements of R-41, in the order the spec lists them. */
export function controlPlaneDenyStatements(t: ControlPlaneDenyTargets): iam.PolicyStatement[] {
  const { partition, region, account, fleetName } = t;
  const deny = (sid: string, actions: readonly string[], resources: string[]) =>
    new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, actions: [...actions], resources });

  const cellBuild = buildRoleArn(partition, account, fleetName, 'cell');
  const tenantBuild = buildRoleArn(partition, account, fleetName, 'tenant');
  const api = apiRoleArn(partition, account, fleetName);
  const globalHook = hookRoleArn(partition, account, fleetName, 'global-hook');
  const appHook = hookRoleArn(partition, account, fleetName, 'app-hook');

  // The roles a pass would hand over: the two build roles, the workflow role,
  // the API role and the two hook roles.
  const passTargets = [cellBuild, tenantBuild, t.workflowRoleArn, api, globalHook, appHook];
  // Every role the stack creates: ten with the hook roles.
  const everyRole = [
    cellBuild,
    tenantBuild,
    provisioningRoleArn(partition, account, fleetName, 'cell'),
    provisioningRoleArn(partition, account, fleetName, 'tenant'),
    globalHook,
    appHook,
    api,
    t.workflowRoleArn,
    t.authorizerRoleArn,
    ...(t.apiGatewayCloudWatchRoleArn === undefined ? [] : [t.apiGatewayCloudWatchRoleArn]),
  ];
  const projects = BUILD_PROJECT_KINDS.map((kind) => buildProjectArn(partition, region, account, fleetName, kind));
  const restApi = `arn:${partition}:apigateway:${region}::/restapis/${t.restApiId}`;

  return [
    deny('DenyPassRole', ['iam:PassRole'], passTargets),
    deny('DenyRoleWrites', DENIED_IAM_ROLE_WRITES, everyRole),
    deny('DenyProjectWrites', DENIED_CODEBUILD_ACTIONS, projects),
    deny('DenyWorkflowStartAndUpdate', ['states:StartExecution', 'states:UpdateStateMachine'], [
      workflowArn(partition, region, account, fleetName),
    ]),
    // Step Functions authorises a redrive on the execution ARN, not the state machine ARN.
    deny('DenyWorkflowRedrive', ['states:RedriveExecution'], [
      workflowExecutionArnPattern(partition, region, account, fleetName),
    ]),
    deny('DenyFunctionWrites', DENIED_LAMBDA_WRITES, [
      ...bothForms(t.apiFunctionArn),
      ...bothForms(t.authorizerFunctionArn),
    ]),
    deny('DenyApiFunctionInvokeAndPermissions', DENIED_LAMBDA_API_ACTIONS, bothForms(t.apiFunctionArn)),
    deny('DenyRestApiWrites', DENIED_APIGATEWAY_ACTIONS, [restApi, `${restApi}/*`]),
    deny('DenyTableWrites', DENIED_DYNAMODB_WRITES, [t.tableArn]),
  ];
}
