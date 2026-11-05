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
import { KEY_PREFIX } from './entitlements';
import type { LogDrain } from './log-drain';
import { acknowledgeGranularFinding } from './nag';
import type { GatewayLimit, OwnedRow } from './reservation.function';

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
  /**
   * (ADR-0040, ADR-0041) Check the gateway's target and tool counts at
   * deploy; `rows` must then hold this target's `GATEWAY#` count row.
   */
  readonly gatewayLimit?: GatewayLimit;
}

/** The `NAME#` rows one CDK app has declared so far, by app root: name → kind. */
const namesByApp = new WeakMap<Construct, Map<string, string>>();

/**
 * Why `rows` clash with a `NAME#` row another construct of this app already
 * declared under another kind, or undefined. The deploy-time condition in
 * reservation.function.ts refuses the same clash across stacks; this catches
 * it at synth when an `AgentBackend` and a `ToolTarget` of one app share a
 * name (a `need` of the agent would otherwise match a tool of the target).
 */
export function nameClashProblem(scope: Construct, rows: readonly OwnedRow[]): string | undefined {
  const root = scope.node.root;
  const names = namesByApp.get(root) ?? new Map<string, string>();
  namesByApp.set(root, names);
  for (const row of rows) {
    const kind = row.attributes?.kind;
    if (!row.PK.startsWith(KEY_PREFIX.name) || kind === undefined) {
      continue;
    }
    const name = row.PK.slice(KEY_PREFIX.name.length);
    const held = names.get(name);
    if (held !== undefined && held !== kind) {
      return `name '${name}' is already declared in this app as a${held === 'agent' ? 'n agent' : ' tool target'}; an agent and a tool target cannot share a name (ADR-0035)`;
    }
    names.set(name, kind);
  }
  return undefined;
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
    const clash = nameClashProblem(this, props.rows);
    if (clash !== undefined) {
      throw new Error(`OwnedRows: ${clash}`);
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
    if (props.gatewayLimit !== undefined) {
      // The gateway's count rows, from every stack: read only, its own partition only.
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'CountGatewayTargets',
          actions: ['dynamodb:Query'],
          resources: [props.tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`${KEY_PREFIX.gateway}${props.gatewayLimit.Gateway}`] } },
        }),
      );
    }
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
        ...(props.gatewayLimit !== undefined ? { GatewayLimit: props.gatewayLimit } : {}),
      },
    });
    if (props.logDrain !== undefined) {
      props.logDrain.writer(this.resource);
      props.logDrain.protect(logGroup);
    }
  }
}
