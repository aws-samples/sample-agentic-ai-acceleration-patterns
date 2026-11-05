// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Lambda behind one of this sample's custom resources: an explicit,
 * deletable log group (ADR-0019), WARN/ERROR log levels so success writes
 * nothing, bundled SDK clients, and the one cdk-nag acknowledgment every
 * such function shares.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { acknowledgeGranularFinding } from './nag';

export function customResourceFunction(
  scope: Construct,
  id: string,
  entry: string,
  description: string,
  timeout: Duration = Duration.minutes(2),
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  const fn = new NodejsFunction(scope, id, {
    entry,
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout,
    logGroup,
    loggingFormat: lambda.LoggingFormat.JSON,
    systemLogLevelV2: lambda.SystemLogLevel.WARN,
    applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
    description,
    bundling: { minify: true, sourceMap: false, externalModules: [] },
  });
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
  );
  return fn;
}
