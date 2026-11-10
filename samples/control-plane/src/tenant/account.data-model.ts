// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DataModel, DynamoDBItem, GSI1_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, ItemUpdate, WriteCondition } from '../shared/repository';
import { AccountOwner } from '../smithy/source/typescript-ssdk-codegen/src';

/** Composite key prefix for account items. */
export const ACCOUNT_KEY_PREFIX = 'ACCOUNT';
/** Fixed sort key — one record per account. */
export const ACCOUNT_SORT_KEY = 'META';
/** GSI-1 static partition value shared by all account items (§4.5). */
export const ACCOUNT_GSI1_PARTITION = 'ACCOUNT';

/**
 * The account domain record (ADR-024): an AWS account the control plane may
 * provision cells into. `owner` decides whether untargeted placement may
 * choose it and is immutable; `maxCells` is operator policy and replaceable;
 * `cellCount` is the authoritative cell counter — claimed in the new-cell
 * placement transaction and released in the cell-delete transaction, never
 * written by `PutAccount` (spec R-24). `externalId` is presented on every
 * AssumeRole into the account (ADR-025) and never returned by the API.
 * There is no status: account operations are synchronous and run no build.
 */
export interface AccountRecord {
  readonly accountId: string;
  readonly owner: AccountOwner;
  readonly maxCells: number;
  readonly cellCount: number;
  readonly externalId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of an {@link AccountRecord}. Account items
 * carry GSI-1 attributes only (static `ACCOUNT` partition for `ListAccounts`
 * and the placement account scan).
 */
export interface AccountItem extends DynamoDBItem {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly accountId: string;
  readonly owner: AccountOwner;
  readonly maxCells: number;
  readonly cellCount: number;
  readonly externalId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for an account. */
export function accountKey(accountId: string): ItemKey {
  return { PK: KeyBuilder.build(ACCOUNT_KEY_PREFIX, accountId), SK: ACCOUNT_SORT_KEY };
}

/**
 * GSI-1 query serving `ListAccounts` and the placement account scan (§4.5).
 * Eventually consistent — the account claim's condition on the base record
 * is the guard (§7).
 */
export function listAccountsQuery(): GsiQuery {
  return {
    indexName: GSI1_INDEX_NAME,
    partitionKey: { name: 'GSI1PK', value: ACCOUNT_GSI1_PARTITION },
  };
}

/**
 * The `PutAccount` create-or-replace write (spec §5.3, R-24) as ONE
 * conditional `UpdateItem`:
 *
 * - policy fields the operator owns are set (`maxCells`, `externalId`,
 *   `updatedAt`);
 * - `owner`, `createdAt`, and `cellCount` are initialised with
 *   `if_not_exists` so a replace never resets the counter or the owner;
 * - the condition `attribute_not_exists(PK) OR owner = :owner` makes an
 *   owner change a condition failure (the service maps it to the 409).
 *
 * Because the write never touches `cellCount` on an existing record, a
 * capacity cut and a concurrent claim compose without a lost update.
 */
export function putAccountUpdate(input: {
  readonly accountId: string;
  readonly owner: AccountOwner;
  readonly maxCells: number;
  readonly externalId?: string;
  readonly now: string;
}): ItemUpdate {
  const names: Record<string, string> = {
    '#owner': 'owner',
    '#maxCells': 'maxCells',
    '#cellCount': 'cellCount',
    '#externalId': 'externalId',
    '#accountId': 'accountId',
    '#createdAt': 'createdAt',
    '#updatedAt': 'updatedAt',
    '#gsi1pk': 'GSI1PK',
    '#gsi1sk': 'GSI1SK',
  };
  const values: Record<string, unknown> = {
    ':owner': input.owner,
    ':maxCells': input.maxCells,
    ':zero': 0,
    ':accountId': input.accountId,
    ':now': input.now,
    ':gsi1pk': ACCOUNT_GSI1_PARTITION,
    ':gsi1sk': KeyBuilder.build(ACCOUNT_KEY_PREFIX, input.accountId),
  };
  const sets = [
    '#owner = if_not_exists(#owner, :owner)',
    '#cellCount = if_not_exists(#cellCount, :zero)',
    '#createdAt = if_not_exists(#createdAt, :now)',
    '#accountId = :accountId',
    '#gsi1pk = :gsi1pk',
    '#gsi1sk = :gsi1sk',
    '#maxCells = :maxCells',
    '#updatedAt = :now',
  ];
  let updateExpression: string;
  if (input.externalId === undefined) {
    updateExpression = `SET ${sets.join(', ')} REMOVE #externalId`;
  } else {
    values[':externalId'] = input.externalId;
    updateExpression = `SET ${[...sets, '#externalId = :externalId'].join(', ')}`;
  }
  return {
    updateExpression,
    conditionExpression: 'attribute_not_exists(PK) OR #owner = :owner',
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

/**
 * The `DeleteAccount` emptiness guard — `attribute_exists(PK) AND
 * cellCount = 0` — the counterpart of the cell-slot claim (ADR-024). The
 * existence check distinguishes "occupied" from "unregistered" only after
 * the fact: the service reads first for the 404 and treats a condition
 * failure as the 409.
 */
export const ACCOUNT_EMPTY_CONDITION: WriteCondition = {
  conditionExpression: 'attribute_exists(PK) AND #cellCount = :zero',
  expressionAttributeNames: { '#cellCount': 'cellCount' },
  expressionAttributeValues: { ':zero': 0 },
};

/** Converts between {@link AccountRecord} and its DynamoDB item. */
export class AccountDataModel implements DataModel<AccountRecord, AccountItem> {
  toItem(record: AccountRecord): AccountItem {
    return {
      ...accountKey(record.accountId),
      GSI1PK: ACCOUNT_GSI1_PARTITION,
      GSI1SK: KeyBuilder.build(ACCOUNT_KEY_PREFIX, record.accountId),
      accountId: record.accountId,
      owner: record.owner,
      maxCells: record.maxCells,
      cellCount: record.cellCount,
      externalId: record.externalId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: AccountItem): AccountRecord {
    return {
      accountId: item.accountId,
      owner: item.owner,
      maxCells: item.maxCells,
      cellCount: item.cellCount,
      externalId: item.externalId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
