// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The cell policies of a standalone cell account (docs/stress-test.spec.md §3.7 and §8,
 * decision 7; stress ADR-0006 and ADR-0011), as typed policy documents the owner stacks
 * attach and the tests pin:
 *
 * - the cell execution policy: what the cell bootstrap's CloudFormation execution role
 *   may create;
 * - the cell permissions boundary: on that execution role; IAM on `role/cell/*` only;
 * - the cell workload boundary: on every role a cell creates; no IAM at all, and
 *   `sts:AssumeRole` on `role/cell/*` only (ADR-0011);
 * - the cell build policy: what the account owner attaches to the role pair's cell
 *   role through control-plane's `cellBuildManagedPolicyArns` (control-plane ADR-0047).
 *
 * Every ARN is built from the stack's partition, account and Region pseudo parameters,
 * so the templates name no account.
 */

import { Aws } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The CDK bootstrap qualifier of the cell bootstrap. */
export const CELL_QUALIFIER = 'cell';
/** The cell bootstrap's stack name. */
export const CELL_TOOLKIT_STACK = 'CDKToolkit-cell';
/** The IAM path every role a cell creates sits on. */
export const CELL_ROLE_PATH = '/cell/';

/**
 * The services the cell creates service-linked roles for on its first deploy in a fresh
 * account (path spike CP-2). IAM fixes their trust to the service.
 */
export const CELL_SERVICE_LINKED_ROLE_SERVICES = [
  'ops.apigateway.amazonaws.com',
  'runtime-identity.bedrock-agentcore.amazonaws.com',
] as const;

/**
 * The services the execution role passes cell roles to: Lambda functions, and the
 * AgentCore Runtime and Gateways. The synthesised runtime-isolation cell has no other
 * role-bearing resource and no role trusted by another service.
 */
export const CELL_PASSED_TO_SERVICES = ['lambda.amazonaws.com', 'bedrock-agentcore.amazonaws.com'] as const;

/** The account owner's SSM parameters no cell principal may write (path spike CP-7). */
export const OWNER_PARAMETER_PATHS = ['/application-plane/shared/identity/*', `/cdk-bootstrap/${CELL_QUALIFIER}/*`] as const;

/** The three cell bootstrap roles a cell build assumes (control-plane ADR-0047); not the lookup role. */
export const CELL_BUILD_BOOTSTRAP_ROLES = ['deploy', 'file-publishing', 'image-publishing'] as const;

/** IAM role writes the cell policies allow on `role/cell/*` and deny elsewhere. */
export const ROLE_WRITE_ACTIONS = [
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:UpdateAssumeRolePolicy',
  'iam:UpdateRole',
  'iam:UpdateRoleDescription',
  'iam:PutRolePermissionsBoundary',
] as const;

/** Removing a boundary, users, keys and policy writes: denied to every cell principal. */
export const IDENTITY_WRITE_ACTIONS = [
  'iam:DeleteRolePermissionsBoundary',
  'iam:DeleteServiceLinkedRole',
  'iam:CreateUser',
  'iam:CreateAccessKey',
  'iam:CreatePolicy',
  'iam:CreatePolicyVersion',
  'iam:DeletePolicy',
  'iam:DeletePolicyVersion',
  'iam:SetDefaultPolicyVersion',
] as const;

/** SSM writes denied on the owner's parameters. */
export const PARAMETER_WRITE_ACTIONS = [
  'ssm:PutParameter',
  'ssm:DeleteParameter',
  'ssm:DeleteParameters',
  'ssm:LabelParameterVersion',
  'ssm:UnlabelParameterVersion',
  'ssm:AddTagsToResource',
  'ssm:RemoveTagsFromResource',
] as const;

/** Changes to the API Gateway account setting, which the owner sets (path spike CP-8). */
export const API_GATEWAY_ACCOUNT_WRITE_ACTIONS = ['apigateway:PATCH', 'apigateway:PUT', 'apigateway:DELETE'] as const;

/** What cell roles call at run time, besides the deploy-time services. */
const RUNTIME_ACTIONS = [
  'execute-api:*',
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:Converse',
  'bedrock:ConverseStream',
  'sts:TagSession',
  'sts:GetCallerIdentity',
  'xray:*',
];

/** The services a cell deploys (spec §8, decision 7). */
const DEPLOY_ACTIONS = [
  'apigateway:*',
  'application-autoscaling:*',
  'bedrock-agentcore:*',
  'cloudwatch:*',
  'dynamodb:*',
  'kms:*',
  'lambda:*',
  'logs:*',
  'ssm:*',
];

const IAM_READ_ACTIONS = ['iam:Get*', 'iam:List*'];

/** The managed policy names. A suffix lets an account owner roll a new set beside an old one. */
export interface CellPolicyNames {
  readonly execution: string;
  readonly boundary: string;
  readonly workloadBoundary: string;
  readonly build: string;
}

const SUFFIX = /^(-[a-z0-9]{1,16})?$/;

/** The names of the four cell policies, with an optional suffix (`-` and up to 16 lower-case letters or digits). */
export function cellPolicyNames(suffix = ''): CellPolicyNames {
  if (!SUFFIX.test(suffix)) {
    throw new Error('the cell policy suffix must be empty or `-` followed by 1 to 16 lower-case letters or digits');
  }
  return {
    execution: `cell-execution-policy${suffix}`,
    boundary: `cell-permissions-boundary${suffix}`,
    workloadBoundary: `cell-workload-boundary${suffix}`,
    build: `cell-build-policy${suffix}`,
  };
}

const iamArn = (resource: string): string => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:${resource}`;

/** `role/cell/*` in this stack's account. */
export const cellRolesArn = (): string => iamArn(`role${CELL_ROLE_PATH}*`);
/** A customer managed policy of this stack's account, by name. */
export const policyArn = (name: string): string => iamArn(`policy/${name}`);

function assetStatement(sid: string): iam.PolicyStatement {
  const bucket = `arn:${Aws.PARTITION}:s3:::cdk-${CELL_QUALIFIER}-assets-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
  return new iam.PolicyStatement({
    sid,
    actions: ['s3:GetObject', 's3:GetBucketLocation', 's3:ListBucket'],
    resources: [bucket, `${bucket}/*`],
  });
}

function passRoleStatement(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'CellPassRole',
    actions: ['iam:PassRole'],
    resources: [cellRolesArn()],
    conditions: { StringEquals: { 'iam:PassedToService': [...CELL_PASSED_TO_SERVICES] } },
  });
}

function serviceLinkedRoleStatement(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'CellServiceLinkedRoles',
    actions: ['iam:CreateServiceLinkedRole'],
    resources: [iamArn('role/aws-service-role/*')],
    conditions: { StringEquals: { 'iam:AWSServiceName': [...CELL_SERVICE_LINKED_ROLE_SERVICES] } },
  });
}

function ownerParameterDeny(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyOwnerParameterWrites',
    effect: iam.Effect.DENY,
    actions: [...PARAMETER_WRITE_ACTIONS],
    resources: OWNER_PARAMETER_PATHS.map((p) => `arn:${Aws.PARTITION}:ssm:*:${Aws.ACCOUNT_ID}:parameter${p}`),
  });
}

function apiGatewayAccountDeny(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyApiGatewayAccountSettings',
    effect: iam.Effect.DENY,
    actions: [...API_GATEWAY_ACCOUNT_WRITE_ACTIONS],
    resources: [`arn:${Aws.PARTITION}:apigateway:*::/account`],
  });
}

/** The cell execution policy: what the cell bootstrap's execution role may create (bounded by the cell boundary). */
export function cellExecutionPolicyDocument(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({ sid: 'CellResources', actions: [...DEPLOY_ACTIONS, ...IAM_READ_ACTIONS], resources: ['*'] }),
      assetStatement('CellAssets'),
      // Role writes include iam:PutRolePermissionsBoundary, so a redeploy can move an existing
      // cell role to a new workload boundary; the cell permissions boundary only lets it set that one.
      new iam.PolicyStatement({ sid: 'CellRoles', actions: [...ROLE_WRITE_ACTIONS], resources: [cellRolesArn()] }),
      passRoleStatement(),
      serviceLinkedRoleStatement(),
    ],
  });
}

/**
 * The cell permissions boundary, on the execution role. It may create, change, pass and
 * assume `/cell/` roles only; a role it creates must carry the workload boundary
 * (ADR-0011), and a role it passes goes to a cell service only.
 */
export function cellPermissionsBoundaryDocument(names: CellPolicyNames): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({ sid: 'CellServices', actions: [...DEPLOY_ACTIONS, ...RUNTIME_ACTIONS, ...IAM_READ_ACTIONS], resources: ['*'] }),
      assetStatement('CellAssets'),
      new iam.PolicyStatement({ sid: 'CellRoles', actions: [...ROLE_WRITE_ACTIONS, 'sts:AssumeRole'], resources: [cellRolesArn()] }),
      passRoleStatement(),
      serviceLinkedRoleStatement(),
      new iam.PolicyStatement({
        sid: 'DenyRoleWithoutTheWorkloadBoundary',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:PermissionsBoundary': policyArn(names.workloadBoundary) } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyIamOutsideCell',
        effect: iam.Effect.DENY,
        actions: [...ROLE_WRITE_ACTIONS, 'iam:PassRole', 'sts:AssumeRole'],
        notResources: [cellRolesArn()],
      }),
      new iam.PolicyStatement({
        sid: 'DenyPassRoleToOtherServices',
        effect: iam.Effect.DENY,
        actions: ['iam:PassRole'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:PassedToService': [...CELL_PASSED_TO_SERVICES] } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyOtherServiceLinkedRoles',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateServiceLinkedRole'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:AWSServiceName': [...CELL_SERVICE_LINKED_ROLE_SERVICES] } },
      }),
      new iam.PolicyStatement({ sid: 'DenyBoundaryRemovalAndIdentityWrites', effect: iam.Effect.DENY, actions: [...IDENTITY_WRITE_ACTIONS], resources: ['*'] }),
      ownerParameterDeny(),
      apiGatewayAccountDeny(),
    ],
  });
}

/**
 * The cell workload boundary, on every role a cell creates (ADR-0011): the services cell
 * roles call, no IAM action at all, and `sts:AssumeRole` on `/cell/` roles only (the TVM
 * assumes the cell's tenant roles).
 */
export function cellWorkloadBoundaryDocument(): iam.PolicyDocument {
  const services = [...DEPLOY_ACTIONS.filter((a) => a !== 'apigateway:*' && a !== 'application-autoscaling:*'), ...RUNTIME_ACTIONS];
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({ sid: 'WorkloadServices', actions: services, resources: ['*'] }),
      assetStatement('WorkloadAssets'),
      new iam.PolicyStatement({ sid: 'WorkloadAssumeCellRoles', actions: ['sts:AssumeRole'], resources: [cellRolesArn()] }),
      new iam.PolicyStatement({ sid: 'DenyIam', effect: iam.Effect.DENY, actions: ['iam:*'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'DenyAssumeOutsideCell', effect: iam.Effect.DENY, actions: ['sts:AssumeRole'], notResources: [cellRolesArn()] }),
      ownerParameterDeny(),
      apiGatewayAccountDeny(),
    ],
  });
}

/** The cell bootstrap roles a cell build assumes, in this stack's account and Region. */
export function cellBuildBootstrapRoleArns(): string[] {
  return CELL_BUILD_BOOTSTRAP_ROLES.map((r) => iamArn(`role/cdk-${CELL_QUALIFIER}-${r}-role-${Aws.ACCOUNT_ID}-${Aws.REGION}`));
}

/**
 * The cell build policy (control-plane ADR-0047): `sts:AssumeRole` on the deploy,
 * file-publishing and image-publishing cell bootstrap roles, and nothing else.
 */
export function cellBuildPolicyDocument(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [new iam.PolicyStatement({ sid: 'AssumeCellBootstrapRoles', actions: ['sts:AssumeRole'], resources: cellBuildBootstrapRoleArns() })],
  });
}
