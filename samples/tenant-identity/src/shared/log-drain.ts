// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct, IConstruct } from 'constructs';
import { suppressTemplateScanners } from './nag';

/**
 * Holds back the deletion of log groups until their writers have stopped
 * and their buffered logs have landed (ADR-0024).
 *
 * API Gateway and Lambda deliver logs a few seconds after the request. If
 * CloudFormation deletes a log group first, the late delivery recreates it,
 * with no retention and outside any stack. The drain sits between the two
 * on delete: writers -> drain (waits) -> log groups.
 *
 * - `protect(logGroup)`: the drain depends on the log group, so the group
 *   is deleted after the drain.
 * - `writer(construct)`: the construct depends on the drain, so it is
 *   deleted before the drain starts waiting.
 *
 * The waiting function writes no logs: its role has no permissions, and its
 * system and application log levels are above anything it emits.
 */
export class LogDrain extends Construct {
  private readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: { readonly delay?: Duration } = {}) {
    super(scope, id);
    const delay = props.delay ?? Duration.seconds(90);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Log drain waiter: no permissions, so it cannot create a log group (ADR-0024)',
    });

    // An explicit, deletable log group. The waiter never writes to it, but
    // without one the useCdkManagedLogGroup feature flag (on in the integ
    // app) adds a retained /aws/lambda group that outlives the stack.
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    suppressTemplateScanners(logGroup, {
      cfnNag: [{ id: 'W84', reason: 'The waiter writes nothing to this group (ADR-0024).' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'The waiter writes nothing to this group (ADR-0024).' }],
    });

    const fn = new lambda.Function(this, 'Function', {
      logGroup,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role,
      timeout: delay.plus(Duration.seconds(30)),
      memorySize: 128,
      description: 'Waits on stack delete so buffered logs land before their log groups go (ADR-0024)',
      code: lambda.Code.fromInline(WAITER_SOURCE),
      // Write nothing at all: Lambda's own START/END/REPORT lines are INFO
      // system logs, and any write would create a log group no stack owns.
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
    });
    suppressTemplateScanners(fn, {
      cfnNag: [
        { id: 'W58', reason: 'The waiter deliberately has no CloudWatch Logs permission: logging would recreate a log group after teardown (ADR-0024).' },
        { id: 'W89', reason: 'Runs only on stack create and delete; no VPC resources are reached. Accepted risk T-24 (threat model).' },
        { id: 'W92', reason: 'Runs once per stack operation; reserved concurrency adds nothing. Accepted risk T-24 (threat model).' },
      ],
      checkov: [
        { id: 'CKV_AWS_115', comment: 'Runs once per stack operation; reserved concurrency adds nothing. Accepted risk T-24 (threat model).' },
        { id: 'CKV_AWS_116', comment: 'CloudFormation retries the custom resource; a DLQ adds nothing. Accepted risk T-24 (threat model).' },
        { id: 'CKV_AWS_117', comment: 'Runs only on stack create and delete; no VPC resources are reached. Accepted risk T-24 (threat model).' },
        { id: 'CKV_AWS_173', comment: 'The function has no environment variables. Accepted risk T-24 (threat model).' },
      ],
    });

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      properties: { DelaySeconds: delay.toSeconds() },
    });
  }

  /** The log group is deleted only after the drain has waited. */
  protect(logGroup: IConstruct): void {
    this.resource.node.addDependency(logGroup);
  }

  /** The writer is deleted before the drain starts waiting. */
  writer(construct: IConstruct): void {
    construct.node.addDependency(this.resource);
  }
}

/**
 * The waiter. Answers Create and Update at once; on Delete it sleeps for
 * DelaySeconds, then answers. It reports through the pre-signed ResponseURL
 * only, never through logs. Exported so a unit test can assert the ADR-0024
 * try/finally without synthesising a stack.
 */
export const WAITER_SOURCE = `
const https = require('https');
const { URL } = require('url');
function respond(event, context, status) {
  const body = JSON.stringify({
    Status: status,
    Reason: 'See ADR-0024',
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
exports.handler = async (event, context) => {
  // ADR-0024: respond() must always run, even if the Delete sleep path throws:
  // a throw before respond would leave CloudFormation waiting the full
  // custom-resource timeout (an hour) on every stack operation.
  try {
    if (event.RequestType === 'Delete') {
      const seconds = Number(event.ResourceProperties.DelaySeconds) || 90;
      await new Promise((r) => setTimeout(r, seconds * 1000));
    }
  } finally {
    await respond(event, context, 'SUCCESS');
  }
};
`;
