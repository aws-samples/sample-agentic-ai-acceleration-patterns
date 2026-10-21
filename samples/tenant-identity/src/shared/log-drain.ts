// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CustomResource, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct, IConstruct } from 'constructs';
import { suppressTemplateScanners } from './nag';

/**
 * Holds back the deletion of log groups until their writers have stopped
 * and their buffered logs have landed (ADR-0019).
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
      description: 'Log drain waiter: no permissions, so it cannot create a log group (ADR-0019)',
    });

    const fn = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      role,
      timeout: delay.plus(Duration.seconds(30)),
      memorySize: 128,
      description: 'Waits on stack delete so buffered logs land before their log groups go (ADR-0019)',
      code: lambda.Code.fromInline(WAITER_SOURCE),
      // Write nothing at all: Lambda's own START/END/REPORT lines are INFO
      // system logs, and any write would create a log group no stack owns.
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
    });
    suppressTemplateScanners(fn, {
      cfnNag: [
        { id: 'W58', reason: 'The waiter deliberately has no CloudWatch Logs permission: logging would recreate a log group after teardown (ADR-0019).' },
        { id: 'W89', reason: 'Runs only on stack create and delete; no VPC resources are reached.' },
        { id: 'W92', reason: 'Runs once per stack operation; reserved concurrency adds nothing.' },
      ],
      checkov: [
        { id: 'CKV_AWS_115', comment: 'Runs once per stack operation; reserved concurrency adds nothing.' },
        { id: 'CKV_AWS_116', comment: 'CloudFormation retries the custom resource; a DLQ adds nothing.' },
        { id: 'CKV_AWS_117', comment: 'Runs only on stack create and delete; no VPC resources are reached.' },
        { id: 'CKV_AWS_173', comment: 'The function has no environment variables.' },
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
 * only, never through logs.
 */
const WAITER_SOURCE = `
const https = require('https');
const { URL } = require('url');
function respond(event, context, status) {
  const body = JSON.stringify({
    Status: status,
    Reason: 'See ADR-0019',
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
  if (event.RequestType === 'Delete') {
    const seconds = Number(event.ResourceProperties.DelaySeconds) || 90;
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  await respond(event, context, 'SUCCESS');
};
`;
