// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One backend's registry entry as a custom resource (ADR-0024). A plain
 * `AWS::SSM::Parameter` disappears the moment its stack deletes it, so
 * running streams on the backend would be cut and the ingress would answer
 * 502 until its cache expired. This resource writes the entry on Create and
 * Update, and on Delete sets `status: draining`, waits one registry TTL plus
 * the longest stream, then removes the parameter (the log-drain shape,
 * ADR-0019). Its role may put, get and delete exactly this one parameter:
 * whoever writes `backends/<name>` chooses which Runtime answers the route,
 * so the write grant is per backend and per name.
 */

import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { acknowledgeGranularFinding } from './nag';
import { registryParameterName } from './registry';

/** The longest stream the `api-gateway` ingress relays (its integration timeout, spike V-5). */
export const LONGEST_STREAM = Duration.minutes(2);

export interface RegistryEntryResourceProps {
  /** The ingress's registry prefix, with its trailing slash. */
  readonly registryPrefix: string;
  /** The backend name, `[a-z0-9-]{1,32}`; the entry is `${registryPrefix}backends/<backend>`. */
  readonly backend: string;
  /** The Runtime ARN the route invokes. */
  readonly runtimeArn: string;
  /** Scopes a token must carry for this backend, on top of the ingress floor. */
  readonly requiredScopes: string[];
  /**
   * How long Delete keeps the entry at `draining` before removing it: one
   * registry TTL (so every ingress instance has stopped routing here) plus
   * the longest stream (so what was routed has finished). Default 180 s.
   */
  readonly drain?: Duration;
}

export class RegistryEntryResource extends Construct {
  /** The SSM parameter name of the entry. */
  readonly parameterName: string;
  /** The custom resource, for dependencies: it must be written after the Runtime, its policy and its target exist. */
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: RegistryEntryResourceProps) {
    super(scope, id);
    const drain = props.drain ?? Duration.seconds(60).plus(LONGEST_STREAM);
    this.parameterName = registryParameterName(props.registryPrefix, props.backend);
    const stack = Stack.of(this);

    // Explicit, deletable log group (ADR-0019). The handler writes nothing on
    // success and Lambda's own START/END/REPORT lines are below WARN, so no
    // late line recreates the group after the stack deleted it.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const fn = new NodejsFunction(this, 'Function', {
      entry: path.join(__dirname, 'registry-entry.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // The Delete path waits the whole drain before answering.
      timeout: drain.plus(Duration.seconds(30)),
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
      description: 'runtime-isolation: writes one backend registry entry; drains it before removal on delete (ADR-0024)',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    // Exactly this parameter: the `parameter` ARN form has no slash before the name's own leading slash.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OwnRegistryEntry',
        actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:DeleteParameter'],
        resources: [`arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${this.parameterName}`],
      }),
    );
    acknowledgeGranularFinding(
      fn,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
    );

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      resourceType: 'Custom::RuntimeIsolationRegistryEntry',
      properties: {
        ParameterName: this.parameterName,
        RuntimeArn: props.runtimeArn,
        RequiredScopes: props.requiredScopes,
        DrainSeconds: drain.toSeconds(),
      },
    });
  }
}
