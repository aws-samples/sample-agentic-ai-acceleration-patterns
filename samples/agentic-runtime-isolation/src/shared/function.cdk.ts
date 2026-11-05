// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared NodejsFunction settings for the request-path Lambdas (the ingress
 * functions, the tools interceptor, the entitlement API, the demo tools),
 * and the two cdk-nag acknowledgments every one of them raises.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { acknowledgeGranularFinding } from './nag';

/** Shared NodejsFunction properties: runtime, arch, tracing, JSON logs, bundling, log group. */
export function functionProps(scope: Construct, logGroupId: string, timeout: Duration): Omit<NodejsFunctionProps, 'entry'> {
  return {
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout,
    tracing: lambda.Tracing.ACTIVE,
    logGroup: new logs.LogGroup(scope, logGroupId, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    }),
    // The logger writes one JSON object per line; the JSON format passes it
    // through as fields (P-9). EMF records bypass console (src/shared/metrics.ts).
    loggingFormat: lambda.LoggingFormat.JSON,
    bundling: {
      minify: true,
      // No source maps: the logger writes error names only, never stacks, and
      // NODE_OPTIONS=--enable-source-maps is not set, so a map is only
      // artifact weight on every cold start.
      sourceMap: false,
      // Bundle the SDK clients so the artifact pins the versions the sample
      // was tested against.
      externalModules: [],
    },
  };
}

/** Acknowledges the two findings every NodejsFunction here raises, with the same reasons. */
export function acknowledgeLambdaFindings(fn: NodejsFunction): void {
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'AWSLambdaBasicExecutionRole is the logs-only managed policy NodejsFunction attaches; a scoped replacement adds boilerplate for no change in access (ADR-0014).',
  );
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM5[Resource::*]',
    "Active X-Ray tracing grants xray:PutTraceSegments/PutTelemetryRecords, which the X-Ray API accepts only on '*' (no resource ARN). Not over-breadth (ADR-0014).",
  );
}
