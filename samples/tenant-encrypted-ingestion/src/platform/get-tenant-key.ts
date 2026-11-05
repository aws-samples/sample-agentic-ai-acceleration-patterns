// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `GetTenantKey` (spec §5.1, P-5, M-18). Runs under `platformRole`.
 *
 * Refreshes `keyStatus` with the probe through S3, under a
 * `tenantPlatformRole` session: `DescribeKey` cannot tell a removed use
 * statement from a healthy key. A KMS-sourced probe failure marks an
 * `ACTIVE` key `REVOKED`; a probe success restores a `REVOKED` key to
 * `ACTIVE`; any other failure changes nothing (a pipeline fault never marks
 * a tenant `REVOKED`). The write is conditional on the status read, so a
 * concurrent `DeleteTenantKey` (`DELETING`) is never overwritten.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PLATFORM_SESSION_MIN_MS, type PlatformDependencies, toSummary } from './common';
import { apiError } from '../api/errors';
import { isConditionalCheckFailed } from '../shared/errors';
import { log } from '../shared/logger';
import { probeKeyThroughS3 } from '../shared/probe';
import { isoNow, type KeyRow, keyRowKey, type KeyStatus, updateInput } from '../shared/registry';
import type { TenantKeySummary } from '../smithy/platform/typescript-ssdk-codegen/src';

/** The status a probe outcome moves a key to, or undefined to leave it. */
export function statusAfterProbe(current: KeyStatus, outcome: 'usable' | 'kms' | 'other'): KeyStatus | undefined {
  if (current === 'ACTIVE' && outcome === 'kms') {
    return 'REVOKED';
  }
  if (current === 'REVOKED' && outcome === 'usable') {
    return 'ACTIVE';
  }
  return undefined;
}

export async function getTenantKey(deps: PlatformDependencies, tenantId: string): Promise<TenantKeySummary> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const row = (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true }))).Item as
    | KeyRow
    | undefined;
  if (row === undefined) {
    throw apiError.notFound('tenant key not found');
  }
  if (row.keyStatus !== 'ACTIVE' && row.keyStatus !== 'REVOKED') {
    return toSummary(row);
  }
  const { client } = await deps.tenant.client(tenantId, 'GetTenantKey', PLATFORM_SESSION_MIN_MS);
  const probe = await probeKeyThroughS3(client.s3, config.bucketName, tenantId, row.keyArn);
  const next = statusAfterProbe(row.keyStatus, probe.outcome);
  if (probe.outcome === 'other') {
    log.warn('key probe inconclusive', { tenantId, operation: 'GetTenantKey', errorType: probe.errorType });
    return toSummary(row);
  }
  const iso = isoNow(now());
  try {
    await deps.ddb.send(
      new UpdateCommand(
        updateInput(config.tableName, keyRowKey(tenantId), {
          set: { keyStatus: next ?? row.keyStatus, lastKeyCheckAt: iso, updatedAt: iso },
          condition: '#keyStatus = :current',
          values: { ':current': row.keyStatus },
        }),
      ),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) {
      throw error;
    }
  }
  if (next !== undefined) {
    log.info('key status changed by probe', { tenantId, operation: 'GetTenantKey', keyStatus: next });
  }
  return toSummary({ ...row, keyStatus: next ?? row.keyStatus, lastKeyCheckAt: iso, updatedAt: iso });
}
