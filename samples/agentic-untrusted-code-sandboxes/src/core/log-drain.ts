// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct, type IConstruct } from 'constructs';

/**
 * Holds back the deletion of log groups until their writers have stopped
 * and their buffered logs have landed (spec §5.3, ADR-0029).
 *
 * Lambda delivers logs a few seconds after the invocation. If CloudFormation
 * deletes a log group first, the late delivery recreates it, with no
 * retention and outside any stack. The drain sits between the two on
 * delete: writers -> drain (waits) -> log groups.
 *
 * - `protect(logGroup)`: the drain depends on the log group, so the group
 *   is deleted after the drain.
 * - `writer(construct)`: the construct depends on the drain, so it is
 *   deleted before the drain starts waiting.
 *
 * The waiting function writes no logs: its role has no permissions, and its
 * log levels are above anything it emits.
 */
export class LogDrain extends Construct {
  private readonly resource: CustomResource;

  public constructor(scope: Construct, id: string, props: { readonly delay?: Duration } = {}) {
    super(scope, id);
    const delay = props.delay ?? Duration.seconds(90);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Log drain waiter: no permissions, so it cannot create a log group (ADR-0029)',
    });

    // An explicit, deletable log group. The waiter never writes to it, but
    // without one the useCdkManagedLogGroup feature flag adds a retained group.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      logGroup,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role,
      timeout: delay.plus(Duration.seconds(30)),
      memorySize: 128,
      description: 'Waits on stack delete so buffered logs land before their log groups go (ADR-0029)',
      code: lambda.Code.fromInline(WAITER_SOURCE),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
    });

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      properties: { DelaySeconds: delay.toSeconds() },
    });
  }

  /** The log group is deleted only after the drain has waited. */
  public protect(logGroup: IConstruct): void {
    this.resource.node.addDependency(logGroup);
  }

  /** The writer is deleted before the drain starts waiting. */
  public writer(construct: IConstruct): void {
    construct.node.addDependency(this.resource);
  }
}

/**
 * The waiter. Answers Create and Update at once; on Delete it sleeps for
 * DelaySeconds, then answers. It answers through the pre-signed ResponseURL
 * only, never through logs, and always answers, so a failed sleep never
 * leaves CloudFormation waiting for the custom resource timeout.
 */
export const WAITER_SOURCE = `
const https = require('https');
const { URL } = require('url');
function respond(event, status) {
  const body = JSON.stringify({
    Status: status,
    Reason: 'See ADR-0029',
    PhysicalResourceId: event.PhysicalResourceId || 'log-drain',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  const url = new URL(event.ResponseURL);
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', resolve);
    req.end(body);
  });
}
exports.handler = async (event) => {
  try {
    if (event.RequestType === 'Delete') {
      const seconds = Number(event.ResourceProperties.DelaySeconds) || 90;
      await new Promise((r) => setTimeout(r, seconds * 1000));
    }
  } finally {
    await respond(event, 'SUCCESS');
  }
};
`;
