// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The bus share guard (ADR-0006, threat model M-6): before an AWS RAM share
 * of the ingest or usage bus is created or changed, the deploy reads the
 * registry and fails if any account the buses are shared with already holds
 * a registered cell. A cell account that could subscribe to a bus would see
 * other tenants' usage. `PutCellEmitter` refuses new cells in those
 * accounts; this check covers the cells registered before the account was
 * added to a list.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { queryAll } from '../shared/db';
import type { EmitterItem } from '../shared/items';
import { LIST_BY_TYPE_INDEX } from '../shared/keys';

/** A registered emitter in an account a bus is to be shared with. */
export interface OffendingEmitter {
  readonly accountId: string;
  readonly cellId: string;
}

type EmitterProjection = Pick<EmitterItem, 'accountId' | 'cellId' | 'expiresAt'>;

/**
 * The registered emitters whose account is in `accountIds`. Every emitter
 * item carries `listType = EMITTER`, so one paginated Query on the
 * `list-by-type` index reads them all, projected to three attributes. An
 * item past its `expiresAt` that TTL has not removed yet counts as absent,
 * as every registry read treats it.
 */
export async function offendingEmitters(
  db: DynamoDBDocumentClient,
  tableName: string,
  accountIds: ReadonlyArray<string>,
  nowMs: number,
): Promise<OffendingEmitter[]> {
  const shared = new Set(accountIds);
  if (shared.size === 0) {
    return [];
  }
  const emitters = await queryAll<EmitterProjection>(db, {
    TableName: tableName,
    IndexName: LIST_BY_TYPE_INDEX,
    KeyConditionExpression: 'listType = :t',
    ExpressionAttributeValues: { ':t': 'EMITTER' },
    ProjectionExpression: 'accountId, cellId, expiresAt',
  });
  return emitters
    .filter((item) => shared.has(item.accountId) && (item.expiresAt === undefined || item.expiresAt * 1000 > nowMs))
    .map((item) => ({ accountId: item.accountId, cellId: item.cellId }));
}

/** The deploy error that names each offending account and cell. */
export function refusal(found: ReadonlyArray<OffendingEmitter>): string {
  const list = found.map((item) => `account ${item.accountId} (cell ${item.cellId})`).join(', ');
  return `a bus may not be shared with an account that holds a registered cell: ${list}. Delete those cells (DeleteCellEmitter) or remove the accounts from rawSubscriberAccountIds / usageSubscriberAccountIds (ADR-0006).`;
}
