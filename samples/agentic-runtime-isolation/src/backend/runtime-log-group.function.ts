// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The Runtime log group custom resource (T-18, M-12). AgentCore creates the
 * Runtime's log group, `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT`, itself
 * at `CreateAgentRuntime`, so a stack cannot own it as an `AWS::Logs::LogGroup`
 * (integration run 2026-11-06: `AlreadyExists`). This handler runs after the
 * Runtime exists and settles the group the service made:
 *
 * - Create and Update: create the group if the service has not yet (the race
 *   goes either way; `ResourceAlreadyExistsException` is success), then put
 *   the retention and the data protection policy on it. The policy masks a
 *   JWT, the base64 credential header and a decoded credential's secret
 *   fields at ingest, so
 *   an agent that logs a header value hands it only to `logs:Unmask` holders.
 * - Delete: delete the group named by the PhysicalResourceId; one that is
 *   already gone is success, and so is an id that is not a Runtime group (a
 *   Create that failed validation has nothing to roll back). The Runtime is
 *   deleted after this resource (the name references its id), so a line it
 *   writes in between recreates the group outside the stack, with no
 *   retention; the integration test deletes such a leftover and the README
 *   tells a deployer to check (ADR-0047).
 *
 * The PhysicalResourceId is the group name, so a replaced Runtime is a new
 * group followed by a Delete of the old one. Writes nothing on success
 * (ADR-0019), one error line on failure, always answers CloudFormation.
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  PutDataProtectionPolicyCommand,
  PutRetentionPolicyCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { type CustomResourceEventBase, type CustomResourceOutcome, respond } from '../shared/cfn-response';
import { errorName, log } from '../shared/logger';

/** The resource properties the construct writes; CloudFormation delivers scalars as strings. */
export interface RuntimeLogGroupProperties {
  readonly LogGroupName: string;
  readonly RetentionInDays: string | number;
  /** The data protection policy document, as JSON. */
  readonly DataProtectionPolicy: string;
  readonly ServiceToken?: string;
}

export interface RuntimeLogGroupEvent extends CustomResourceEventBase {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: RuntimeLogGroupProperties;
  readonly OldResourceProperties?: RuntimeLogGroupProperties;
}

const LOG_GROUP_PREFIX = '/aws/bedrock-agentcore/runtimes/';

/**
 * Errors the service returns for a call that may well pass a moment later.
 * `PutDataProtectionPolicy` compiles the policy's regexes on the call and
 * answers `HttpTimeoutException` when that takes longer than its own limit
 * (integration run 2026-11-06: about 5 s with a `{16,4096}` bound, half the
 * calls timed out); `OperationAbortedException` is a write racing the
 * service's own setup of a group it just created. The SDK's retry mode
 * treats neither as retryable, so the handler does.
 */
const TRANSIENT_ERRORS = new Set([
  'HttpTimeoutException',
  'OperationAbortedException',
  'ThrottlingException',
  'ServiceUnavailableException',
]);
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 2_000;

export interface RuntimeLogGroupDependencies {
  readonly logs: CloudWatchLogsClient;
  /** The backoff sleep between attempts; tests pass a no-op. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** Runs a Logs write, retrying a transient service error with exponential backoff and full jitter. */
async function withRetry<T>(deps: RuntimeLogGroupDependencies, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt + 1 >= RETRY_ATTEMPTS || !TRANSIENT_ERRORS.has(errorName(error))) {
        throw error;
      }
      await deps.sleep(Math.floor(Math.random() * RETRY_BASE_MS * 2 ** attempt));
    }
  }
}

export async function handleEvent(
  event: RuntimeLogGroupEvent,
  logsClient: CloudWatchLogsClient,
  sleep: RuntimeLogGroupDependencies['sleep'] = defaultSleep,
): Promise<CustomResourceOutcome> {
  const deps: RuntimeLogGroupDependencies = { logs: logsClient, sleep };
  const properties = event.ResourceProperties;

  if (event.RequestType === 'Delete') {
    // The group this resource stands for, which after a Runtime replacement
    // is the OLD name, not the one in the current properties.
    const name = event.PhysicalResourceId ?? '';
    if (!name.startsWith(LOG_GROUP_PREFIX)) {
      return { status: 'SUCCESS', physicalResourceId: name || 'runtime-log-group' };
    }
    try {
      await logsClient.send(new DeleteLogGroupCommand({ logGroupName: name }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) {
        log.error('runtime log group delete failed', { logGroup: name, error: errorName(error) });
        return { status: 'FAILED', physicalResourceId: name, reason: `DeleteLogGroup failed: ${errorName(error)}` };
      }
    }
    return { status: 'SUCCESS', physicalResourceId: name };
  }

  const name = properties.LogGroupName;
  if (typeof name !== 'string' || !name.startsWith(LOG_GROUP_PREFIX)) {
    return {
      status: 'FAILED',
      physicalResourceId: event.PhysicalResourceId ?? 'runtime-log-group',
      reason: `LogGroupName must start with ${LOG_GROUP_PREFIX}`,
    };
  }
  const retention = Number(properties.RetentionInDays);
  if (!Number.isInteger(retention) || retention < 1) {
    return { status: 'FAILED', physicalResourceId: name, reason: 'RetentionInDays must be a positive integer' };
  }
  if (typeof properties.DataProtectionPolicy !== 'string' || properties.DataProtectionPolicy.length === 0) {
    return { status: 'FAILED', physicalResourceId: name, reason: 'DataProtectionPolicy must be a JSON document' };
  }
  try {
    try {
      await logsClient.send(new CreateLogGroupCommand({ logGroupName: name }));
    } catch (error) {
      if (!(error instanceof ResourceAlreadyExistsException)) {
        throw error;
      }
    }
    await withRetry(deps, () => logsClient.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: retention })));
    await withRetry(deps, () =>
      logsClient.send(new PutDataProtectionPolicyCommand({ logGroupIdentifier: name, policyDocument: properties.DataProtectionPolicy })),
    );
    return { status: 'SUCCESS', physicalResourceId: name };
  } catch (error) {
    log.error('runtime log group settle failed', { logGroup: name, error: errorName(error) });
    return { status: 'FAILED', physicalResourceId: name, reason: `${errorName(error)} on ${name}` };
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const logsClient = new CloudWatchLogsClient({ retryMode: 'adaptive', maxAttempts: 8 });

/** The Lambda entry point. */
export const handler = async (event: RuntimeLogGroupEvent): Promise<void> => {
  let outcome: CustomResourceOutcome;
  try {
    outcome = await handleEvent(event, logsClient);
  } catch (error) {
    log.error('runtime log group handler failed', { error: errorName(error) });
    outcome = {
      status: 'FAILED',
      physicalResourceId: event.PhysicalResourceId ?? event.ResourceProperties?.LogGroupName ?? 'runtime-log-group',
      reason: errorName(error),
    };
  }
  await respond(event, outcome);
};
