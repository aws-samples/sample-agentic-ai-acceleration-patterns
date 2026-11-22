// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The bus share guard (ADR-0006, threat model M-6): before an AWS RAM share
 * of the ingest or usage bus is created or changed, the deploy reads the
 * registry and fails if any account the buses are shared with holds an
 * emitter that can still send. An emitter account that could subscribe to
 * a bus would see other tenants' usage. `PutEmitter` refuses new emitters
 * in those accounts; this check covers the emitters registered before the
 * account was added to a list.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { queryAll } from '../shared/db';
import type { EmitterRoleItem } from '../shared/items';
import { LIST_BY_TYPE_INDEX } from '../shared/keys';

/** A registered emitter in an account a bus is to be shared with. */
export interface OffendingEmitter {
  readonly accountId: string;
  readonly emitterId: string;
  readonly status: EmitterRoleItem['status'];
  /** Set on a `CLOSING` emitter: when it stops counting. */
  readonly closesAt?: string;
}

type EmitterProjection = Pick<EmitterRoleItem, 'accountId' | 'emitterId' | 'status' | 'closesAt'>;

/**
 * Whether an emitter can still send: `ACTIVE`, or `CLOSING` with `closesAt`
 * still ahead, or with a `closesAt` that is missing or unreadable (the
 * cautious reading of an item the registry never writes). Past `closesAt`
 * ingest admits nothing from it (spec §4.2), so a deleted emitter stops
 * counting at its close time, not at TTL.
 */
export function canStillSend(item: Pick<EmitterRoleItem, 'status' | 'closesAt'>, nowMs: number): boolean {
  if (item.status === 'ACTIVE') {
    return true;
  }
  const closes = item.closesAt === undefined ? Number.NaN : Date.parse(item.closesAt);
  return Number.isNaN(closes) || closes > nowMs;
}

/**
 * The registered emitters that can still send and whose account is in
 * `accountIds`. Every emitter item carries `listType = EMITTER`, so one
 * paginated Query on the `list-by-type` index reads them all, projected to
 * four attributes.
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
    // `status` is a DynamoDB reserved word.
    ExpressionAttributeNames: { '#status': 'status' },
    ProjectionExpression: 'accountId, emitterId, #status, closesAt',
  });
  return emitters
    .filter((item) => shared.has(item.accountId) && canStillSend(item, nowMs))
    .map((item) => ({
      accountId: item.accountId,
      emitterId: item.emitterId,
      status: item.status,
      ...(item.closesAt !== undefined ? { closesAt: item.closesAt } : {}),
    }));
}

function describeEmitter(item: OffendingEmitter): string {
  const state = item.status === 'CLOSING' && item.closesAt !== undefined ? `CLOSING until ${item.closesAt}` : item.status;
  return `account ${item.accountId} (emitter ${item.emitterId}, ${state})`;
}

/** The deploy error that names each offending account and emitter, with its state. */
export function refusal(found: ReadonlyArray<OffendingEmitter>): string {
  const list = found.map(describeEmitter).join(', ');
  return `a bus may not be shared with an account that holds an emitter that can still send: ${list}. Delete those emitters (DeleteEmitter) and deploy again after their close time (closesAt), or remove the accounts from rawSubscriberAccountIds / usageSubscriberAccountIds (ADR-0006).`;
}
