// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The account owner's stacks of a standalone cell account (spec §3.7; stress ADR-0006):
 *
 * - `CellPoliciesStack`: the cell execution policy, the cell permissions boundary, the
 *   cell workload boundary (ADR-0011) and the cell build policy (control-plane ADR-0047).
 *   It deploys before the cell bootstrap, which names the first two.
 * - `CellAccountBaseStack`: the API Gateway account's CloudWatch Logs role and setting,
 *   and the identity parameters a cell reads (`/application-plane/shared/identity/*`).
 *
 * Both use the CDK's legacy synthesizer: an asset-free template deployed inline with the
 * owner's credentials, so the account never needs a default CDK bootstrap (path spike
 * CP-5). Both carry the stack tag `stress:part=account-base`, by which the control-plane
 * slice's account check tells them apart (spec §3.7). Their roles stay on `/` with no
 * cell boundary.
 */

import { LegacyStackSynthesizer, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import {
  cellBuildPolicyDocument,
  cellExecutionPolicyDocument,
  cellPermissionsBoundaryDocument,
  cellWorkloadBoundaryDocument,
  type CellPolicyNames,
} from './cell-policies';
import { acknowledgeGranularFinding } from '../driver/nag';

/** The stack tag of every account-base stack (spec §3.7). */
export const ACCOUNT_BASE_TAG = { key: 'stress:part', value: 'account-base' } as const;

/** The identity parameters a cell reads. */
export const IDENTITY_PARAMETERS = {
  userPoolId: '/application-plane/shared/identity/userPoolId',
  appClientId: '/application-plane/shared/identity/appClientId',
} as const;

/** Props of an owner stack: the legacy synthesizer is fixed. */
export type OwnerStackProps = Omit<StackProps, 'synthesizer'>;

/** The legacy synthesizer and the account-base stack tag, on top of the caller's props. */
function ownerProps(props: OwnerStackProps): StackProps {
  return { ...props, synthesizer: new LegacyStackSynthesizer(), tags: { ...props.tags, [ACCOUNT_BASE_TAG.key]: ACCOUNT_BASE_TAG.value } };
}

export interface CellPoliciesStackProps extends OwnerStackProps {
  readonly names: CellPolicyNames;
}

/** The four cell policies, as customer managed policies with fixed names. */
export class CellPoliciesStack extends Stack {
  readonly executionPolicy: iam.ManagedPolicy;
  readonly permissionsBoundary: iam.ManagedPolicy;
  readonly workloadBoundary: iam.ManagedPolicy;
  readonly buildPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: CellPoliciesStackProps) {
    super(scope, id, ownerProps(props));
    const { names } = props;

    this.permissionsBoundary = new iam.ManagedPolicy(this, 'CellPermissionsBoundary', {
      managedPolicyName: names.boundary,
      description: 'Caps the cell bootstrap execution role: IAM on role/cell/* only; roles it creates carry the workload boundary',
      document: cellPermissionsBoundaryDocument(names),
    });
    this.workloadBoundary = new iam.ManagedPolicy(this, 'CellWorkloadBoundary', {
      managedPolicyName: names.workloadBoundary,
      description: 'Caps every role a cell creates: no IAM, sts:AssumeRole on role/cell/* only',
      document: cellWorkloadBoundaryDocument(),
    });
    this.executionPolicy = new iam.ManagedPolicy(this, 'CellExecutionPolicy', {
      managedPolicyName: names.execution,
      description: 'What the cell bootstrap execution role may create (bounded by the cell permissions boundary)',
      document: cellExecutionPolicyDocument(names),
    });
    this.buildPolicy = new iam.ManagedPolicy(this, 'CellBuildPolicy', {
      managedPolicyName: names.build,
      description: 'For the role pair cell role (cellBuildManagedPolicyArns): assume the cell bootstrap deploy and publishing roles only',
      document: cellBuildPolicyDocument(),
    });

    const reason =
      'Cell policies for a standalone cell account that holds only cells, the cell bootstrap and the owner stacks (spec §3.7, ADR-0006): ' +
      'IAM is scoped to role/cell/* and the explicit denies keep cell principals off every other role, policy, owner parameter and the API Gateway account setting; ' +
      'the service grants are bounded by the account itself.';
    for (const policy of [this.permissionsBoundary, this.workloadBoundary, this.executionPolicy, this.buildPolicy]) {
      acknowledgeWildcards(policy, reason);
    }
  }
}

/**
 * Acknowledges each granular cdk-nag IAM5 finding of a managed policy's allow statements,
 * one wildcard action or resource at a time, so a new wildcard fails the synth until it is
 * reviewed.
 */
function acknowledgeWildcards(policy: iam.ManagedPolicy, reason: string): void {
  const doc = Stack.of(policy).resolve(policy.document.toJSON()) as { Statement: Array<Record<string, unknown>> };
  const ids = new Set<string>();
  const each = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  for (const st of doc.Statement.filter((s) => s.Effect === 'Allow')) {
    for (const a of each(st.Action)) {
      if (String(a).includes('*')) ids.add(`AwsSolutions-IAM5[Action::${String(a)}]`);
    }
    for (const r of each(st.Resource)) {
      const rendered = flattenForNag(r);
      if (rendered.includes('*')) ids.add(`AwsSolutions-IAM5[Resource::${rendered}]`);
    }
  }
  for (const id of ids) acknowledgeGranularFinding(policy, id, reason);
}

function flattenForNag(node: unknown): string {
  if (typeof node === 'string') return node;
  const obj = node as Record<string, unknown>;
  if (obj['Fn::Join'] !== undefined) {
    const [d, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map(flattenForNag).join(d);
  }
  if (typeof obj.Ref === 'string') return `<${obj.Ref}>`;
  return JSON.stringify(node);
}

export interface CellAccountBaseStackProps extends OwnerStackProps {
  /** The stress identity's user pool id; with `appClientId`, writes the identity parameters. */
  readonly userPoolId?: string;
  /** The stress identity's app client id. */
  readonly appClientId?: string;
}

/** The API Gateway account's CloudWatch Logs role and setting, and the identity parameters. */
export class CellAccountBaseStack extends Stack {
  readonly apiGatewayLogsRole: iam.Role;

  constructor(scope: Construct, id: string, props: CellAccountBaseStackProps = {}) {
    super(scope, id, ownerProps(props));
    if ((props.userPoolId === undefined) !== (props.appClientId === undefined)) {
      throw new Error('give both userPoolId and appClientId, or neither');
    }

    // Every runtime-isolation stage writes access and execution logs (path spike CP-4).
    this.apiGatewayLogsRole = new iam.Role(this, 'ApiGatewayLogsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      description: 'API Gateway account CloudWatch Logs role, set by the cell account owner',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')],
    });
    acknowledgeGranularFinding(
      this.apiGatewayLogsRole,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
      'The AWS managed policy API Gateway documents for its account CloudWatch Logs role.',
    );
    // The role ARN reference orders the setting after the role.
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', { cloudWatchRoleArn: this.apiGatewayLogsRole.roleArn });

    if (props.userPoolId !== undefined && props.appClientId !== undefined) {
      new ssm.StringParameter(this, 'UserPoolId', { parameterName: IDENTITY_PARAMETERS.userPoolId, stringValue: props.userPoolId });
      new ssm.StringParameter(this, 'AppClientId', { parameterName: IDENTITY_PARAMETERS.appClientId, stringValue: props.appClientId });
    }
  }
}
