// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `DeleteTenantKey`: offboarding is cryptographic and total (spec P-6,
 * §5.1, ADR-0005, M-26). Runs under `platformRole`; every S3 call under a
 * `tenantPlatformRole` session for the tenant.
 *
 * 1. `keyStatus = DELETING`: `CreateDelivery` presigns nothing from here on.
 * 2. With `tenantThrottle`, the tenant's API key goes (its `/tenant/*`
 *    calls stop at API Gateway).
 * 3. Every version and delete marker under `ingest/<t>/` and
 *    `documents/<t>/` is deleted.
 * 4. `vendor-key`: the alias is deleted and the key scheduled for deletion
 *    (`keyDeletionWindowDays`). `tenant-key`: the key is the tenant's and is
 *    left untouched.
 * 5. The row and `KEYARN#` are removed in one transaction.
 *
 * Every step is idempotent, so a call that failed part-way is resumed by
 * repeating it; a missing row is 204. A PUT already in flight fails on the
 * pending-deletion key (`vendor-key`) or lands an object the processor
 * deletes because the row is missing (`tenant-key`); the 1-day
 * noncurrent-version lifecycle on `ingest/` removes that version.
 */

import { DeleteApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { DeleteAliasCommand, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms';
import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keyAliasName, PLATFORM_SESSION_MIN_MS, type PlatformDependencies } from './common';
import { DOCUMENTS_PREFIX, INGEST_PREFIX } from '../shared/constants';
import { errorCode, isConditionalCheckFailed } from '../shared/errors';
import { log } from '../shared/logger';
import { isoNow, keyArnItemKey, type KeyRow, keyRowKey, updateInput } from '../shared/registry';

/** Codes that mean "already done" for a step of the offboarding. */
const ALREADY_GONE = new Set(['NotFoundException', 'KMSInvalidStateException']);

/** Deletes every version and delete marker under `prefix`; returns how many. */
export async function deleteAllVersions(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key !== undefined && v.VersionId !== undefined)
      .map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
      if ((result.Errors ?? []).length > 0) {
        throw new Error(`DeleteObjects left ${result.Errors!.length} versions (${result.Errors![0].Code ?? 'unknown'})`);
      }
      deleted += batch.length;
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  return deleted;
}

async function ignoreGone(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (!ALREADY_GONE.has(errorCode(error))) {
      throw error;
    }
  }
}

export async function deleteTenantKey(deps: PlatformDependencies, tenantId: string): Promise<{ statusCode: number }> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const row = (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true }))).Item as
    | KeyRow
    | undefined;
  if (row === undefined) {
    return { statusCode: 204 };
  }

  // 1. Stop presigning.
  if (row.keyStatus !== 'DELETING') {
    try {
      await deps.ddb.send(
        new UpdateCommand(
          updateInput(config.tableName, keyRowKey(tenantId), {
            set: { keyStatus: 'DELETING', updatedAt: isoNow(now()) },
            condition: 'attribute_exists(#PK)',
          }),
        ),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return { statusCode: 204 };
      }
      throw error;
    }
  }

  // 2. The tenant's API key.
  if (row.apiKeyId !== undefined && deps.apiGateway !== undefined) {
    await deps.apiGateway.send(new DeleteApiKeyCommand({ apiKey: row.apiKeyId })).catch((error: unknown) => {
      if (errorCode(error) !== 'NotFoundException') {
        throw error;
      }
    });
  }

  // 3. Every version under both prefixes, under the tenant's own session.
  const { client } = await deps.tenant.client(tenantId, 'DeleteTenantKey', PLATFORM_SESSION_MIN_MS);
  let removed = 0;
  for (const prefix of [`${INGEST_PREFIX}${tenantId}/`, `${DOCUMENTS_PREFIX}${tenantId}/`]) {
    removed += await deleteAllVersions(client.s3, config.bucketName, prefix);
  }

  // 4. vendor-key: alias and key.
  if (row.tier === 'vendor-key') {
    await ignoreGone(deps.kms.send(new DeleteAliasCommand({ AliasName: keyAliasName(tenantId) })));
    await ignoreGone(deps.kms.send(new ScheduleKeyDeletionCommand({ KeyId: row.keyArn, PendingWindowInDays: config.keyDeletionWindowDays })));
  }

  // 5. Row and KEYARN# together.
  await deps.ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: config.tableName,
            Key: keyRowKey(tenantId),
            ConditionExpression: '#keyStatus = :deleting',
            ExpressionAttributeNames: { '#keyStatus': 'keyStatus' },
            ExpressionAttributeValues: { ':deleting': 'DELETING' },
          },
        },
        { Delete: { TableName: config.tableName, Key: keyArnItemKey(row.keyArn) } },
      ],
    }),
  );
  log.info('tenant offboarded', { tenantId, operation: 'DeleteTenantKey', tier: row.tier, count: removed });
  return { statusCode: 202 };
}
