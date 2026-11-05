// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `RotateTenantKey` (spec §5.1, P-4). Runs under `platformRole`.
 * `vendor-key`: `RotateKeyOnDemand`; a key past its on-demand rotation
 * quota (25 per key, N-3) is a 409 `RotationLimitReached`. `tenant-key`:
 * 400 `UnsupportedInTier` (the tenant rotates its own key). Rotation keeps
 * ARN, alias and old material; nothing is re-encrypted.
 */

import { RotateKeyOnDemandCommand } from '@aws-sdk/client-kms';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PlatformDependencies } from './common';
import { apiError } from '../api/errors';
import { errorCode } from '../shared/errors';
import { log } from '../shared/logger';
import { type KeyRow, keyRowKey } from '../shared/registry';

export async function rotateTenantKey(deps: PlatformDependencies, tenantId: string): Promise<{ tenantId: string; rotationStarted: boolean }> {
  const row = (await deps.ddb.send(new GetCommand({ TableName: deps.config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true })))
    .Item as KeyRow | undefined;
  if (row === undefined) {
    throw apiError.notFound('tenant key not found');
  }
  if (row.tier === 'tenant-key') {
    throw apiError.unsupportedInTier('a tenant-key key is rotated by its tenant');
  }
  if (row.keyStatus !== 'ACTIVE') {
    throw apiError.conflict('the tenant key is not ACTIVE');
  }
  try {
    await deps.kms.send(new RotateKeyOnDemandCommand({ KeyId: row.keyArn }));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'LimitExceededException') {
      throw apiError.conflict('RotationLimitReached: the key has used its on-demand rotations');
    }
    if (code === 'ConflictException') {
      throw apiError.conflict('a rotation of this key is already in progress');
    }
    throw error;
  }
  log.info('key rotation started', { tenantId, operation: 'RotateTenantKey' });
  return { tenantId, rotationStarted: true };
}
