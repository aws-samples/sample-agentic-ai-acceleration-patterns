// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ArnFormat, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { acknowledgeServiceTimeout } from './nag';

/**
 * Deletes the log groups that AWS services create outside the stack: the
 * AgentCore runtime groups under `/aws/bedrock-agentcore/runtimes/<name>-`
 * and the MicroVM image build group (spec §5.3, C-6). The names and
 * prefixes are known at synth and passed as properties, so the resource
 * holds no reference to the runtime or the image. Each backend resource
 * depends on this resource, so CloudFormation deletes this one after them.
 *
 * The role may delete only groups under those prefixes and names (spec
 * §3.6 "Log cleanup role").
 */
export interface LogCleanupProps {
  readonly prefixes: string[];
  readonly names: string[];
}

export class LogCleanup extends Construct {
  public readonly resource: CustomResource;

  public constructor(scope: Construct, id: string, props: LogCleanupProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const arn = (name: string, wildcard: boolean) => stack.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: wildcard ? `${name}*` : name,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Deletes the log groups AWS services create for the sandboxes backends (spec 3.6)',
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeLogGroups',
      actions: ['logs:DescribeLogGroups'],
      // The action authorizes against the log-group resource type with no name; it takes only a wildcard.
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'DeleteOwnedLogGroups',
      actions: ['logs:DeleteLogGroup'],
      resources: [
        ...props.prefixes.map((p) => arn(p, true)),
        // Both forms of the group ARN: the log group authorizes DeleteLogGroup against either, and the exact one is unverified.
        ...props.names.flatMap((n) => [arn(n, false), arn(`${n}:`, true)]),
      ],
    }));

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, 'Function', {
      logGroup,
      role,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: Duration.minutes(5),
      memorySize: 128,
      description: 'Deletes service-created log groups of the sandboxes backends on stack delete (spec 5.3)',
      code: lambda.Code.fromInline(CLEANUP_SOURCE),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      applicationLogLevelV2: lambda.ApplicationLogLevel.ERROR,
    });
    logGroup.grantWrite(role);

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: fn.functionArn,
      properties: { Prefixes: props.prefixes, Names: props.names },
      serviceTimeout: Duration.minutes(6),
    });
    acknowledgeServiceTimeout(this.resource);
  }
}

/**
 * The cleanup handler. Create and Update answer at once. Delete lists the
 * groups under each prefix, deletes them and the named groups, ignores a
 * group that is already gone, and always answers through the ResponseURL.
 * Exported for the unit test.
 */
export const CLEANUP_SOURCE = `
const https = require('https');
const { URL } = require('url');
const { CloudWatchLogsClient, DescribeLogGroupsCommand, DeleteLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs');
function respond(event, status, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || 'See spec 5.3',
    PhysicalResourceId: event.PhysicalResourceId || 'log-cleanup',
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
async function remove(client, name) {
  try {
    await client.send(new DeleteLogGroupCommand({ logGroupName: name }));
  } catch (e) {
    if (e && e.name === 'ResourceNotFoundException') return;
    throw e;
  }
}
exports.handler = async (event) => {
  let status = 'SUCCESS';
  let reason;
  try {
    if (event.RequestType === 'Delete') {
      const client = new CloudWatchLogsClient({});
      const props = event.ResourceProperties || {};
      for (const prefix of props.Prefixes || []) {
        let token;
        do {
          const page = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken: token }));
          for (const g of page.logGroups || []) await remove(client, g.logGroupName);
          token = page.nextToken;
        } while (token);
      }
      for (const name of props.Names || []) await remove(client, name);
    }
  } catch (e) {
    status = 'FAILED';
    reason = String((e && e.message) || e).slice(0, 200);
  } finally {
    await respond(event, status, reason);
  }
};
`;
