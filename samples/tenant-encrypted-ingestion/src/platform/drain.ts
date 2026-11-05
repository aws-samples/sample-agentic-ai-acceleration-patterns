// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stack-delete key drain (spec §6.2 "Clean teardown", ADR-0005, M-26).
 * A CloudFormation custom resource under `platformRole`; the API and the
 * platform functions depend on it, so on stack delete CloudFormation removes
 * them first and only then sends this resource its Delete.
 *
 * On Delete it schedules for deletion (`keyDeletionWindowDays`):
 * 1. every `vendor-key` key the registry still binds, and
 * 2. as a backstop, every key carrying this stack's `tei:stack` tag that
 *    the registry no longer knows (a create in flight when the API went),
 *    found with `ListKeys` and `ListResourceTags`. Keys whose policy does not
 *    admit `platformRole` (any key this stack did not create) answer
 *    `AccessDenied` to `ListResourceTags` and are skipped.
 *
 * `tenant-key` keys belong to their tenants and are never touched. Create
 * and Update do nothing. The handler always answers CloudFormation, before
 * the function's own deadline, and reports Delete as SUCCESS even when a key
 * could not be scheduled (logged), so a stack delete never hangs on a key.
 */

import * as https from 'node:https';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient, ListKeysCommand, ListResourceTagsCommand, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudFormationCustomResourceEvent, Context as LambdaContext } from 'aws-lambda';
import { ENV, requireEnv, requireIntEnv, STACK_TAG_KEY } from '../shared/constants';
import { errorCode } from '../shared/errors';
import { errorName, log } from '../shared/logger';
import { KEY_SK, type KeyRow, tenantOfPk } from '../shared/registry';

export interface DrainDependencies {
  readonly ddb: DynamoDBDocumentClient;
  readonly kms: KMSClient;
  readonly tableName: string;
  readonly stackId: string;
  readonly windowDays: number;
}

const ALREADY_GONE = new Set(['NotFoundException', 'KMSInvalidStateException']);

async function schedule(deps: DrainDependencies, keyArn: string, tenantId: string | undefined): Promise<boolean> {
  try {
    await deps.kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArn, PendingWindowInDays: deps.windowDays }));
    return true;
  } catch (error) {
    if (!ALREADY_GONE.has(errorCode(error))) {
      log.error('key not scheduled for deletion', { tenantId, operation: 'drain', errorType: errorName(error) });
    }
    return false;
  }
}

/** The drain itself; returns how many keys it scheduled. */
export async function drainKeys(deps: DrainDependencies): Promise<number> {
  let scheduled = 0;
  const known = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: '#SK = :key AND begins_with(#PK, :tenant)',
        ExpressionAttributeNames: { '#SK': 'SK', '#PK': 'PK' },
        ExpressionAttributeValues: { ':key': KEY_SK, ':tenant': 'TENANT#' },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (page.Items ?? []) as KeyRow[]) {
      known.add(item.keyArn);
      if (item.tier === 'vendor-key' && (await schedule(deps, item.keyArn, tenantOfPk(item.PK)))) {
        scheduled++;
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  let marker: string | undefined;
  do {
    const page = await deps.kms.send(new ListKeysCommand({ Marker: marker }));
    for (const key of page.Keys ?? []) {
      if (key.KeyArn === undefined || known.has(key.KeyArn)) {
        continue;
      }
      let tags;
      try {
        tags = (await deps.kms.send(new ListResourceTagsCommand({ KeyId: key.KeyArn }))).Tags ?? [];
      } catch {
        continue; // not a key this stack's role administers
      }
      if (tags.some((t) => t.TagKey === STACK_TAG_KEY && t.TagValue === deps.stackId) && (await schedule(deps, key.KeyArn, undefined))) {
        scheduled++;
      }
    }
    marker = page.Truncated ? page.NextMarker : undefined;
  } while (marker !== undefined);
  return scheduled;
}

function respond(event: CloudFormationCustomResourceEvent, status: 'SUCCESS' | 'FAILED', reason: string): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId: 'PhysicalResourceId' in event ? event.PhysicalResourceId : 'tenant-key-drain',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  const url = new URL(event.ResponseURL);
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'PUT', headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end(body);
  });
}

let deps: DrainDependencies | undefined;

export async function handler(event: CloudFormationCustomResourceEvent, context: LambdaContext): Promise<void> {
  let reason = 'nothing to do';
  try {
    if (event.RequestType === 'Delete') {
      deps ??= {
        ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        kms: new KMSClient({}),
        tableName: requireEnv(ENV.tableName),
        stackId: requireEnv(ENV.stackId),
        windowDays: requireIntEnv(ENV.keyDeletionWindowDays),
      };
      const deadline = new Promise<number>((resolve) => setTimeout(() => resolve(-1), Math.max(1000, context.getRemainingTimeInMillis() - 5000)));
      const scheduled = await Promise.race([drainKeys(deps), deadline]);
      reason = scheduled < 0 ? 'drain stopped at the deadline' : `scheduled ${scheduled} keys`;
      log.info('key drain finished', { operation: 'drain', count: scheduled });
    }
  } catch (error) {
    reason = `drain failed: ${errorName(error)}`;
    log.error('key drain failed', { operation: 'drain', errorType: errorName(error) });
  } finally {
    await respond(event, 'SUCCESS', reason);
  }
}
