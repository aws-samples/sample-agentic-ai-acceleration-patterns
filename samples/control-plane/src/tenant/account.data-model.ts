// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StoredLastGlobalHook, readLastGlobalHooks } from './hook.data-model';
import { LastGlobalHookEntry } from './hook.types';
import { readRecordStatus } from './record-event.types';
import { DataModel, DynamoDBItem, GSI1_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, ItemUpdate } from '../shared/repository';
import { AccountOwner, LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

/** Composite key prefix for account items. */
export const ACCOUNT_KEY_PREFIX = 'ACCOUNT';
/** Fixed sort key — one record per account. */
export const ACCOUNT_SORT_KEY = 'META';
/** GSI-1 static partition value shared by all account items (§4.7). */
export const ACCOUNT_GSI1_PARTITION = 'ACCOUNT';

/**
 * The account domain record (ADR-024): an AWS account the control plane may
 * provision cells into. `owner` decides whether untargeted placement may
 * choose it and is immutable; `applicationIds` names the applications the
 * account admits — absent, the account is shared and admits every
 * application (ADR-033); `maxCells` is operator policy and replaceable;
 * `cellCount` is the authoritative cell counter — claimed in the new-cell
 * placement transaction and released in the cell-delete transaction, never
 * written by `PutAccount` (spec R-24). `externalId` is presented on every
 * AssumeRole into the account (ADR-025) and never returned by the API.
 * Account mutations are asynchronous so that global hooks on account events
 * can gate them (ADR-045): `status` (absent on an item stored before
 * ADR-045, read as `ACTIVE`, R-47), `statusReason`, `lastGlobalHooks`
 * (terminal writes only, R-40), `pending` (the `maxCells` and
 * `applicationIds` a replace staged while `UPDATING`, never `externalId`,
 * R-48) and `operationId` (R-51).
 */
export interface AccountRecord {
  readonly accountId: string;
  readonly owner: AccountOwner;
  /** Admitted applications; `undefined` = shared (admits all). Never empty. */
  readonly applicationIds?: readonly string[];
  readonly maxCells: number;
  readonly cellCount: number;
  readonly externalId?: string;
  readonly status: LifecycleStatus;
  readonly statusReason?: string;
  readonly lastGlobalHooks?: readonly LastGlobalHookEntry[];
  readonly pending?: AccountPending;
  readonly operationId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The values a replacing `PutAccount` staged (R-48): the `maxCells` and
 * `applicationIds` the commit makes live; an absent `applicationIds` makes
 * the account shared once committed (R-50). Never holds `externalId`, which
 * the replace writes into the record at once. Present only while
 * `UPDATING`.
 */
export interface AccountPending {
  readonly maxCells: number;
  readonly applicationIds?: readonly string[];
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
  readonly applicationIds?: readonly string[];
  readonly maxCells: number;
  readonly cellCount: number;
  readonly externalId?: string;
  /** Absent on an item stored before ADR-045; read as `ACTIVE` (R-47). */
  readonly status?: LifecycleStatus;
  readonly statusReason?: string;
  /** Written by the workflow's terminal writes: a list of maps, see `readLastGlobalHooks`. */
  readonly lastGlobalHooks?: readonly StoredLastGlobalHook[];
  readonly pending?: AccountPending;
  readonly operationId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Copies only `maxCells` and `applicationIds`, so an `externalId` (or
 * anything else) found in `pending` never reaches the domain or the API
 * (R-48, T46).
 */
function readAccountPending(pending: AccountPending | undefined): AccountPending | undefined {
  if (pending === undefined) {
    return undefined;
  }
  return {
    maxCells: pending.maxCells,
    ...(pending.applicationIds === undefined ? {} : { applicationIds: [...pending.applicationIds] }),
  };
}

/** Builds the composite base-table key for an account. */
export function accountKey(accountId: string): ItemKey {
  return { PK: KeyBuilder.build(ACCOUNT_KEY_PREFIX, accountId), SK: ACCOUNT_SORT_KEY };
}

/**
 * GSI-1 query serving `ListAccounts` and the placement account scan (§4.7).
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
 * The path a `PutAccount` takes, chosen from a strongly consistent read
 * (R-48, §5.4): `CREATE` for an id with no record, `RE_PUT` for a
 * `CREATE_FAILED` record, `REPLACE` for a live one, `ROTATE` for an
 * `UPDATING` one whose change in flight the request repeats.
 */
export type PutAccountPath = 'CREATE' | 'RE_PUT' | 'REPLACE' | 'ROTATE';

/**
 * The `PutAccount` write (spec §5.4, R-24, R-48) as ONE conditional
 * `UpdateItem` on every path. `owner` is immutable: every path but the
 * create is conditioned on `owner = :owner`, and `cellCount` is never
 * written (a create initialises it through `if_not_exists`).
 *
 * - `CREATE`: the policy fields into the record, `CREATING`, conditional
 *   on `attribute_not_exists(PK)`.
 * - `RE_PUT`: the policy fields into the record and back to `CREATING`,
 *   conditional on `status = CREATE_FAILED`.
 * - `REPLACE`: `externalId` into the record at once (never staged, the
 *   probe has proved it), `maxCells` and `applicationIds` into `pending`,
 *   and the record to `UPDATING`, conditional on `ACTIVE`/`UPDATE_FAILED`
 *   (or an absent status, R-47).
 * - `ROTATE`: `externalId` and `updatedAt` only, conditional on
 *   `status = UPDATING AND operationId = :readOperationId`, the
 *   `operationId` the request read; status, `pending` and `operationId`
 *   are kept and no execution starts.
 *
 * An absent `externalId` is REMOVEd on every path but the create; an absent
 * `applicationIds` is REMOVEd on a re-put (the account is shared) and left
 * out of `pending` on a replace (the commit removes it). Every path but the
 * rotation stores the new `operationId` (R-51) and clears `statusReason`.
 */
export function putAccountUpdate(input: {
  readonly path: PutAccountPath;
  readonly accountId: string;
  readonly owner: AccountOwner;
  readonly maxCells: number;
  readonly applicationIds?: readonly string[];
  readonly externalId?: string;
  /** The new operation's id; on `ROTATE`, the `operationId` the request read (its condition). */
  readonly operationId?: string;
  readonly now: string;
}): ItemUpdate {
  const { path } = input;
  // DynamoDB refuses a name or value an expression does not use, so each is
  // added with the clause that uses it.
  const names: Record<string, string> = { '#owner': 'owner', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':owner': input.owner, ':now': input.now };
  const sets = ['#updatedAt = :now'];
  const removes: string[] = [];
  const conditions: string[] = [];

  if (input.externalId !== undefined) {
    names['#externalId'] = 'externalId';
    values[':externalId'] = input.externalId;
    sets.push('#externalId = :externalId');
  } else if (path !== 'CREATE') {
    names['#externalId'] = 'externalId';
    removes.push('#externalId');
  }

  if (path === 'ROTATE') {
    names['#status'] = 'status';
    names['#operationId'] = 'operationId';
    values[':updating'] = LifecycleStatus.UPDATING;
    conditions.push('#owner = :owner', '#status = :updating');
    if (input.operationId === undefined) {
      conditions.push('attribute_not_exists(#operationId)');
    } else {
      values[':readOperationId'] = input.operationId;
      conditions.push('#operationId = :readOperationId');
    }
  } else {
    if (input.operationId === undefined) {
      throw new Error(`PutAccount ${path}: an operationId is required`);
    }
    Object.assign(names, { '#status': 'status', '#operationId': 'operationId' });
    values[':operationId'] = input.operationId;
    sets.push('#status = :status', '#operationId = :operationId');
    if (path === 'REPLACE') {
      names['#pending'] = 'pending';
      values[':pending'] = {
        maxCells: input.maxCells,
        ...(input.applicationIds === undefined ? {} : { applicationIds: [...input.applicationIds] }),
      };
      values[':status'] = LifecycleStatus.UPDATING;
      values[':active'] = LifecycleStatus.ACTIVE;
      values[':updateFailed'] = LifecycleStatus.UPDATE_FAILED;
      sets.push('#pending = :pending');
      conditions.push('#owner = :owner', '(attribute_not_exists(#status) OR #status IN (:active, :updateFailed))');
    } else {
      Object.assign(names, {
        '#maxCells': 'maxCells',
        '#cellCount': 'cellCount',
        '#accountId': 'accountId',
        '#createdAt': 'createdAt',
        '#gsi1pk': 'GSI1PK',
        '#gsi1sk': 'GSI1SK',
      });
      Object.assign(values, {
        ':status': LifecycleStatus.CREATING,
        ':maxCells': input.maxCells,
        ':zero': 0,
        ':accountId': input.accountId,
        ':gsi1pk': ACCOUNT_GSI1_PARTITION,
        ':gsi1sk': KeyBuilder.build(ACCOUNT_KEY_PREFIX, input.accountId),
      });
      sets.push(
        '#owner = :owner',
        '#cellCount = if_not_exists(#cellCount, :zero)',
        '#createdAt = if_not_exists(#createdAt, :now)',
        '#accountId = :accountId',
        '#gsi1pk = :gsi1pk',
        '#gsi1sk = :gsi1sk',
        '#maxCells = :maxCells',
      );
      if (input.applicationIds !== undefined) {
        names['#applicationIds'] = 'applicationIds';
        values[':applicationIds'] = [...input.applicationIds];
        sets.push('#applicationIds = :applicationIds');
      } else if (path === 'RE_PUT') {
        names['#applicationIds'] = 'applicationIds';
        removes.push('#applicationIds');
      }
      if (path === 'CREATE') {
        conditions.push('attribute_not_exists(PK)');
      } else {
        values[':createFailed'] = LifecycleStatus.CREATE_FAILED;
        conditions.push('#status = :createFailed', '#owner = :owner');
      }
    }
    if (path !== 'CREATE') {
      names['#statusReason'] = 'statusReason';
      removes.push('#statusReason');
    }
  }

  return {
    updateExpression: `SET ${sets.join(', ')}` + (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : ''),
    conditionExpression: conditions.join(' AND '),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

/** Converts between {@link AccountRecord} and its DynamoDB item. */
export class AccountDataModel implements DataModel<AccountRecord, AccountItem> {
  toItem(record: AccountRecord): AccountItem {
    return {
      ...accountKey(record.accountId),
      GSI1PK: ACCOUNT_GSI1_PARTITION,
      GSI1SK: KeyBuilder.build(ACCOUNT_KEY_PREFIX, record.accountId),
      accountId: record.accountId,
      owner: record.owner,
      applicationIds: record.applicationIds === undefined ? undefined : [...record.applicationIds],
      maxCells: record.maxCells,
      cellCount: record.cellCount,
      externalId: record.externalId,
      status: record.status,
      statusReason: record.statusReason,
      lastGlobalHooks: record.lastGlobalHooks,
      pending: readAccountPending(record.pending),
      operationId: record.operationId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: AccountItem): AccountRecord {
    return {
      accountId: item.accountId,
      owner: item.owner,
      applicationIds: item.applicationIds === undefined ? undefined : [...item.applicationIds],
      maxCells: item.maxCells,
      cellCount: item.cellCount,
      externalId: item.externalId,
      status: readRecordStatus(item.status),
      statusReason: item.statusReason,
      lastGlobalHooks: item.lastGlobalHooks === undefined ? undefined : readLastGlobalHooks(item.lastGlobalHooks),
      pending: readAccountPending(item.pending),
      operationId: item.operationId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
