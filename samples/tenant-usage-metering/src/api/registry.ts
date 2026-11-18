// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Registrations (spec §3.4, §4.2, §4.3): what the control plane's vendor
 * hooks write. Every operation is idempotent, because hooks run again on
 * updates, retries and cleanups: `Put*` reaches the same item whatever its
 * prior state, and `Delete*` succeeds on a missing or closing item.
 *
 * An emitter is two items: `EMITTER#<account>#<role>` (status and
 * intervals, what ingest reads) and `CELL#<cell>` (which emitter a cell
 * has). A binding is two copies: under the cell (what ingest reads) and
 * under the tenant (what the recount and the dispatcher read). Both pairs
 * are written in one transaction.
 */

import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { type AdminContext, type AdminDeps, nowOf, toDate } from './deps';
import { apiError } from './errors';
import { startJob } from './jobs';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import { getItem } from '../shared/db';
import { emitterRoleName } from '../shared/identity';
import type { BindingItem, CellItem, EmitterItem, IntervalItem } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { closeAttributes, reactivation, type Trace, updateExpression } from '../shared/registration';
import { isConditionFailure } from '../shared/retry';
import { iso } from '../shared/time';
import type { CellEmitterSummary, Interval, TenantBindingSummary } from '../smithy/metering/typescript-ssdk-codegen/src';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const intervalsOut = (intervals: IntervalItem[] | undefined): Interval[] | undefined =>
  intervals?.map((interval) => ({
    activeFrom: toDate(interval.activeFrom),
    closedAt: toDate(interval.closedAt),
    closedByExecutionId: interval.closedByExecutionId,
    closedByOperatorId: interval.closedByOperatorId,
  }));

export function emitterOut(item: EmitterItem): CellEmitterSummary {
  return {
    cellId: item.cellId,
    applicationId: item.applicationId,
    accountId: item.accountId,
    roleName: item.roleName,
    status: item.status,
    activeFrom: toDate(item.activeFrom),
    closedAt: toDate(item.closedAt),
    closesAt: toDate(item.closesAt),
    controlPlaneExecutionId: item.controlPlaneExecutionId,
    controlPlaneOperatorId: item.controlPlaneOperatorId,
    closedByExecutionId: item.closedByExecutionId,
    closedByOperatorId: item.closedByOperatorId,
    intervals: intervalsOut(item.intervals),
    createdBy: item.createdBy,
    createdAt: toDate(item.createdAt),
  };
}

export function bindingOut(item: BindingItem): TenantBindingSummary {
  return {
    cellId: item.cellId,
    tenantId: item.tenantId,
    applicationId: item.applicationId,
    billingAccount: item.billingAccount,
    status: item.status,
    activeFrom: toDate(item.activeFrom),
    closedAt: toDate(item.closedAt),
    closesAt: toDate(item.closesAt),
    controlPlaneExecutionId: item.controlPlaneExecutionId,
    controlPlaneOperatorId: item.controlPlaneOperatorId,
    closedByExecutionId: item.closedByExecutionId,
    closedByOperatorId: item.closedByOperatorId,
    intervals: intervalsOut(item.intervals),
    createdBy: item.createdBy,
    createdAt: toDate(item.createdAt),
  };
}

async function transact(deps: AdminDeps, items: TransactItem[]): Promise<void> {
  try {
    await deps.db.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      throw apiError.conflict('CONCURRENT_WRITE', 'the registration changed; retry');
    }
    throw error;
  }
}

/** An `Update` with a condition, the condition's names and values kept apart from the update's. */
function update(
  tableName: string,
  key: { PK: string; SK: string },
  set: Record<string, unknown>,
  remove: string[],
  condition: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
): TransactItem {
  const expression = updateExpression(set, remove);
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: expression.UpdateExpression,
      ConditionExpression: condition,
      ExpressionAttributeNames: { ...expression.ExpressionAttributeNames, ...names },
      ExpressionAttributeValues:
        Object.keys({ ...expression.ExpressionAttributeValues, ...values }).length > 0
          ? { ...expression.ExpressionAttributeValues, ...values }
          : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Cell emitters (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * A registration item that TTL has not removed yet but whose `expiresAt` has
 * passed counts as absent. DynamoDB deletes expired items late, and deletes
 * the two items of a pair separately, so every read treats them alike and
 * every write repairs the other item of the pair (review v1 #2).
 */
function live<T extends { expiresAt?: number }>(item: T | undefined, nowMs: number): T | undefined {
  return item !== undefined && (item.expiresAt === undefined || item.expiresAt * 1000 > nowMs) ? item : undefined;
}

/** A stored item with a set/remove pair applied. */
function applied<T>(stored: T, set: Record<string, unknown>, remove: ReadonlyArray<string>): T {
  const out = { ...stored, ...set } as Record<string, unknown>;
  for (const name of remove) {
    delete out[name];
  }
  return out as T;
}

const nowSeconds = (nowMs: number) => Math.floor(nowMs / 1000);

/** The cell item may be written only where it is absent, expired, or already this account's and application's. */
function cellPut(tableName: string, item: CellItem, nowMs: number): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK) OR expiresAt <= :now OR (accountId = :a AND applicationId = :app)',
      ExpressionAttributeValues: { ':now': nowSeconds(nowMs), ':a': item.accountId, ':app': item.applicationId },
    },
  };
}

function cellItemOf(emitter: EmitterItem): CellItem {
  return {
    ...keys.cell(emitter.cellId),
    SK: 'META',
    cellId: emitter.cellId,
    accountId: emitter.accountId,
    roleName: emitter.roleName,
    applicationId: emitter.applicationId,
    ...(emitter.expiresAt !== undefined ? { expiresAt: emitter.expiresAt } : {}),
  };
}

/** The live cell item and the live emitter it names. */
async function readEmitter(deps: AdminDeps, cellId: string, nowMs: number): Promise<{ cell?: CellItem; emitter?: EmitterItem }> {
  const cell = live(await getItem<CellItem>(deps.db, deps.config.tableName, keys.cell(cellId), true), nowMs);
  if (cell === undefined) {
    return {};
  }
  const emitter = live(await getItem<EmitterItem>(deps.db, deps.config.tableName, keys.emitter(cell.accountId, cell.roleName), true), nowMs);
  return { cell, emitter };
}

export async function putCellEmitter(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { cellId: string; applicationId: string; accountId: string; trace: Trace },
): Promise<EmitterItem> {
  const { tableName, fleetName, recountWindowHours } = deps.config;
  if (deps.config.blockedAccountIds.includes(input.accountId)) {
    throw apiError.conflict('ACCOUNT_NOT_ALLOWED', 'a cell may not live in the metering account or in an account a bus is shared with');
  }
  const roleName = emitterRoleName(fleetName, input.cellId);
  const nowMs = nowOf(deps);
  const emitterKey = keys.emitter(input.accountId, roleName);
  const cell = live(await getItem<CellItem>(deps.db, tableName, keys.cell(input.cellId), true), nowMs);
  if (cell !== undefined && (cell.accountId !== input.accountId || cell.applicationId !== input.applicationId)) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the cell is registered with another account or application');
  }
  // Read by the requested key, so an emitter whose cell item TTL already removed is still found.
  const emitter = live(await getItem<EmitterItem>(deps.db, tableName, emitterKey, true), nowMs);

  if (emitter === undefined) {
    const item = {
      ...emitterKey,
      SK: 'META' as const,
      cellId: input.cellId,
      applicationId: input.applicationId,
      accountId: input.accountId,
      roleName,
      status: 'ACTIVE' as const,
      activeFrom: iso(nowMs),
      controlPlaneExecutionId: input.trace.executionId,
      controlPlaneOperatorId: input.trace.operatorId,
      createdBy: ctx.caller.roleArn,
      createdAt: iso(nowMs),
      listType: 'EMITTER',
      listSort: input.cellId,
    } satisfies EmitterItem & { listType: string; listSort: string };
    await transact(deps, [
      cellPut(tableName, cellItemOf(item), nowMs),
      {
        Put: {
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK) OR expiresAt <= :now',
          ExpressionAttributeValues: { ':now': nowSeconds(nowMs) },
        },
      },
    ]);
    return item;
  }
  if (emitter.status === 'ACTIVE') {
    if (cell === undefined) {
      await transact(deps, [cellPut(tableName, cellItemOf(emitter), nowMs)]);
    }
    return emitter;
  }
  const { set, remove } = reactivation(emitter, nowMs, recountWindowHours, input.trace);
  const next = applied(emitter, set, remove);
  await transact(deps, [
    update(
      tableName,
      emitterKey,
      set,
      remove,
      '#cs = :closing AND closedAt = :seen',
      { '#cs': 'status' },
      { ':closing': 'CLOSING', ':seen': emitter.closedAt },
    ),
    cellPut(tableName, cellItemOf(next), nowMs),
  ]);
  return next;
}

export async function getCellEmitter(deps: AdminDeps, cellId: string): Promise<EmitterItem> {
  const { emitter } = await readEmitter(deps, cellId, nowOf(deps));
  if (emitter === undefined) {
    throw apiError.notFound('no emitter is registered for this cell');
  }
  return emitter;
}

export async function deleteCellEmitter(deps: AdminDeps, cellId: string, trace: Trace): Promise<EmitterItem | undefined> {
  const { tableName, closeGraceMinutes, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const { cell, emitter } = await readEmitter(deps, cellId, nowMs);
  if (cell === undefined || emitter === undefined || emitter.status === 'CLOSING') {
    return emitter;
  }
  const close = closeAttributes(nowMs, closeGraceMinutes, recountWindowHours, trace);
  const next = applied(emitter, close, []);
  await transact(deps, [
    update(
      tableName,
      keys.emitter(cell.accountId, cell.roleName),
      close,
      [],
      '#cs = :active',
      { '#cs': 'status' },
      { ':active': 'ACTIVE' },
    ),
    cellPut(tableName, cellItemOf(next), nowMs),
  ]);
  return next;
}

export async function listCellEmitters(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ emitters: EmitterItem[]; nextToken?: string }> {
  const query = 'ListCellEmitters';
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      IndexName: LIST_BY_TYPE_INDEX,
      KeyConditionExpression: 'listType = :t',
      ExpressionAttributeValues: { ':t': 'EMITTER' },
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  return {
    // An item past its expiresAt is absent, as Get* treats it (review v2 #6).
    emitters: ((page.Items ?? []) as EmitterItem[]).filter((item) => live(item, nowOf(deps)) !== undefined),
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}

// ---------------------------------------------------------------------------
// Tenant bindings (spec §4.3)
// ---------------------------------------------------------------------------

/**
 * Writes a binding: the cell copy (what ingest reads) under `condition`,
 * and the tenant copy as a full put, so a copy TTL removed early is
 * rewritten rather than failing the call (review v1 #2).
 */
function bindingWrites(
  tableName: string,
  next: BindingItem,
  condition: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
): TransactItem[] {
  return [
    {
      Put: {
        TableName: tableName,
        Item: { ...next, ...keys.binding(next.cellId, next.tenantId) },
        ConditionExpression: condition,
        ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
        ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
      },
    },
    { Put: { TableName: tableName, Item: { ...next, ...keys.bindingLookup(next.tenantId, next.applicationId, next.cellId) } } },
  ];
}

export async function putTenantBinding(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { cellId: string; tenantId: string; applicationId: string; billingAccount?: string; trace: Trace },
): Promise<{ binding: BindingItem; resendJobId?: string }> {
  const { tableName, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const { cell, emitter } = await readEmitter(deps, input.cellId, nowMs);
  if (cell === undefined || emitter === undefined || emitter.status !== 'ACTIVE' || cell.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the cell has no ACTIVE emitter of this application');
  }
  const stored = live(await getItem<BindingItem>(deps.db, tableName, keys.binding(input.cellId, input.tenantId), true), nowMs);
  if (stored !== undefined && stored.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the tenant is bound to this cell for another application');
  }
  const billingChanged = input.billingAccount !== undefined && input.billingAccount !== stored?.billingAccount;
  // A resend that could not be started last time is started now (review v1 #5).
  const resend = billingChanged || stored?.resendPending === true;
  const billing = billingChanged ? { billingAccount: input.billingAccount, resendPending: true } : {};

  let binding: BindingItem;
  if (stored === undefined) {
    binding = {
      ...keys.binding(input.cellId, input.tenantId),
      cellId: input.cellId,
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      status: 'ACTIVE',
      activeFrom: iso(nowMs),
      controlPlaneExecutionId: input.trace.executionId,
      controlPlaneOperatorId: input.trace.operatorId,
      createdBy: ctx.caller.roleArn,
      createdAt: iso(nowMs),
      ...billing,
    };
    await transact(deps, bindingWrites(tableName, binding, 'attribute_not_exists(PK) OR expiresAt <= :now', {}, { ':now': nowSeconds(nowMs) }));
  } else if (stored.status === 'ACTIVE') {
    binding = applied(stored, billing, []);
    if (billingChanged) {
      await transact(
        deps,
        bindingWrites(
          tableName,
          binding,
          stored.billingAccount === undefined ? '#cs = :active AND attribute_not_exists(billingAccount)' : '#cs = :active AND billingAccount = :old',
          { '#cs': 'status' },
          stored.billingAccount === undefined ? { ':active': 'ACTIVE' } : { ':active': 'ACTIVE', ':old': stored.billingAccount },
        ),
      );
    }
  } else {
    const { set, remove } = reactivation(stored, nowMs, recountWindowHours, input.trace);
    binding = applied(stored, { ...set, ...billing }, remove);
    await transact(
      deps,
      bindingWrites(tableName, binding, '#cs = :closing AND closedAt = :seen', { '#cs': 'status' }, { ':closing': 'CLOSING', ':seen': stored.closedAt }),
    );
  }

  if (!resend) {
    return { binding };
  }
  // A billing account just set unblocks the tenant's BLOCKED deliveries (spec §4.7).
  const job = await startJob(deps, ctx, 'RESEND_BLOCKED', { tenantId: input.tenantId, applicationId: input.applicationId });
  // Clear the flag alone, on each copy that still holds it, so a delete or
  // a billing change committed in between is left as it is (review v2 #1).
  for (const key of [keys.binding(binding.cellId, binding.tenantId), keys.bindingLookup(binding.tenantId, binding.applicationId, binding.cellId)]) {
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: 'REMOVE resendPending',
          ConditionExpression: 'resendPending = :true',
          ExpressionAttributeValues: { ':true': true },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) {
        throw error;
      }
    }
  }
  return { binding: applied(binding, {}, ['resendPending']), resendJobId: job.jobId };
}

export async function getTenantBinding(deps: AdminDeps, cellId: string, tenantId: string): Promise<BindingItem> {
  const item = live(await getItem<BindingItem>(deps.db, deps.config.tableName, keys.binding(cellId, tenantId), true), nowOf(deps));
  if (item === undefined) {
    throw apiError.notFound('no such binding');
  }
  return item;
}

export async function deleteTenantBinding(
  deps: AdminDeps,
  cellId: string,
  tenantId: string,
  trace: Trace,
): Promise<BindingItem | undefined> {
  const { tableName, closeGraceMinutes, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const stored = live(await getItem<BindingItem>(deps.db, tableName, keys.binding(cellId, tenantId), true), nowMs);
  if (stored === undefined || stored.status === 'CLOSING') {
    return stored;
  }
  const next = applied(stored, closeAttributes(nowMs, closeGraceMinutes, recountWindowHours, trace), []);
  await transact(deps, bindingWrites(tableName, next, '#cs = :active', { '#cs': 'status' }, { ':active': 'ACTIVE' }));
  return next;
}

export async function listTenantBindings(
  deps: AdminDeps,
  cellId: string,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ bindings: BindingItem[]; nextToken?: string }> {
  const query = `ListTenantBindings#${cellId}`;
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)',
      ExpressionAttributeValues: { ':pk': keys.cellPk(cellId), ':t': 'TENANT#' },
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  return {
    bindings: ((page.Items ?? []) as BindingItem[]).filter((item) => live(item, nowOf(deps)) !== undefined),
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}
