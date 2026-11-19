// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `CellRouteAccess` (spec §3.1, §5.2, ADR-0011): used in a cell stack, in
 * the cell's account. It lets the front door's edge distribution, and only
 * it, reach the cell's Lambda function URL through origin access control:
 * `cloudfront.amazonaws.com` gets `lambda:InvokeFunctionUrl` and
 * `lambda:InvokeFunction` on the function, each conditioned on the
 * distribution's ARN (`SourceArn`). Spike S-3 found both actions are
 * needed; with only `InvokeFunctionUrl` the edge gets 403.
 *
 * The distribution ARN comes from the `distributionArn` prop, or from the
 * cell-account copy parameter `paramCellCopy(applicationId)` (§6.4), which
 * the application's shared stack writes in each cell account.
 */

import { Token } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { paramCellCopy } from '../shared/contracts';

export interface CellRouteAccessProps {
  /** The cell API's function, the one behind the function URL the route table names. */
  readonly function: lambda.IFunction;
  /**
   * The edge distribution's ARN. Omit it to read the ARN from the cell-account
   * copy parameter of `applicationId` at deploy time.
   */
  readonly distributionArn?: string;
  /** The control-plane application; names the copy parameter when `distributionArn` is omitted. */
  readonly applicationId?: string;
}

/** A literal CloudFront distribution ARN (the partition may differ). */
const DISTRIBUTION_ARN = /^arn:aws[a-z-]*:cloudfront::\d{12}:distribution\/[A-Z0-9]+$/;
/** An application id that is safe in an SSM path and an IAM resource. */
export const APPLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class CellRouteAccess extends Construct {
  /** The distribution ARN the permissions are conditioned on (may be a token). */
  public readonly distributionArn: string;

  constructor(scope: Construct, id: string, props: CellRouteAccessProps) {
    super(scope, id);
    this.distributionArn = resolveDistributionArn(this, props);

    const principal = 'cloudfront.amazonaws.com';
    new lambda.CfnPermission(this, 'InvokeFunctionUrl', {
      action: 'lambda:InvokeFunctionUrl',
      functionName: props.function.functionArn,
      principal,
      sourceArn: this.distributionArn,
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    new lambda.CfnPermission(this, 'InvokeFunction', {
      action: 'lambda:InvokeFunction',
      functionName: props.function.functionArn,
      principal,
      sourceArn: this.distributionArn,
    });
  }
}

function resolveDistributionArn(scope: Construct, props: CellRouteAccessProps): string {
  if (props.distributionArn !== undefined) {
    if (!Token.isUnresolved(props.distributionArn) && !DISTRIBUTION_ARN.test(props.distributionArn)) {
      throw new Error(`CellRouteAccess: distributionArn must be a CloudFront distribution ARN, got ${JSON.stringify(props.distributionArn)}`);
    }
    return props.distributionArn;
  }
  if (props.applicationId === undefined) {
    throw new Error('CellRouteAccess: set distributionArn, or applicationId to read it from the cell-account copy parameter');
  }
  if (!Token.isUnresolved(props.applicationId) && !APPLICATION_ID.test(props.applicationId)) {
    throw new Error(`CellRouteAccess: applicationId must match ${APPLICATION_ID}, got ${JSON.stringify(props.applicationId)}`);
  }
  // The parameter holds the distribution ARN as a plain string
  // (CellCopyParameter, ADR-0026). A wrong value gives a SourceArn no
  // distribution has, which fails closed: the edge gets 403.
  return ssm.StringParameter.valueForStringParameter(scope, paramCellCopy(props.applicationId));
}
