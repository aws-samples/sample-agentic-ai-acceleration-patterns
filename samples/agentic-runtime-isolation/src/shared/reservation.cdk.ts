// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `OwnedRows` (spec §4.5, C-16, C-17; ADR-0035): writes a fixed set of
 * owner-marked rows into the entitlement store at deploy and removes them
 * at delete, through src/shared/reservation.function.ts. `AgentBackend` owns
 * its `NAME#<name>` row; `ToolTarget` owns `NAME#<target>` and its
 * `TOOL#<target>` catalogue rows. The function's role may put and delete
 * items only under exactly the partition keys it owns (`dynamodb:LeadingKeys`),
 * so whoever runs it cannot write a tenant's subscription or cuts.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { LogDrain } from './log-drain';
import { acknowledgeGranularFinding } from './nag';
import type { OwnedRow } from './reservation.function';

/** The longest explicit owner marker (ADR-0035). */
export const OWNER_MAX_LENGTH = 200;

/** Why an explicit `owner` is refused, or undefined when it is acceptable (or unset). */
export function ownerProblem(owner: string | undefined): string | undefined {
  if (owner === undefined) {
    return undefined;
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    return 'must be a non-empty string';
  }
  if (owner.length > OWNER_MAX_LENGTH) {
    return `must be at most ${OWNER_MAX_LENGTH} characters (got ${owner.length})`;
  }
  if (owner.includes('#')) {
    return "must not contain '#' (the separator of the default <StackId>#<LogicalResourceId> marker)";
  }
  return undefined;
}

export interface OwnedRowsProps {
  /** The entitlement store's table name and ARN (possibly another stack's, read from its published parameters). */
  readonly tableName: string;
  readonly tableArn: string;
  readonly rows: OwnedRow[];
  /** An explicit owner marker; default `<StackId>#<LogicalResourceId>`. Stacks that share one co-own the rows. */
  readonly owner?: string;
  /** The log drain (ADR-0019) that holds this function's log group back until its last line has landed. */
  readonly logDrain?: LogDrain;
}

export class OwnedRows extends Construct {
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: OwnedRowsProps) {
    super(scope, id);
    if (props.rows.length === 0) {
      throw new Error('OwnedRows: rows must not be empty');
    }
    const problem = ownerProblem(props.owner);
    if (problem !== undefined) {
      throw new Error(`OwnedRows: owner ${problem}`);
    }
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, 'reservation.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.minutes(2),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
      description: 'runtime-isolation: owner-marked name and catalogue rows in the entitlement store (ADR-0035)',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    const partitions = [...new Set(props.rows.map((r) => r.PK))];
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OwnRowsOnly',
        actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
        resources: [props.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': partitions } },
      }),
    );
    acknowledgeGranularFinding(
      fn,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
    );
    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::RuntimeIsolationOwnedRows',
      properties: {
        TableName: props.tableName,
        Rows: props.rows,
        ...(props.owner !== undefined ? { Owner: props.owner } : {}),
      },
    });
    if (props.logDrain !== undefined) {
      props.logDrain.writer(this.resource);
      props.logDrain.protect(logGroup);
    }
  }
}
