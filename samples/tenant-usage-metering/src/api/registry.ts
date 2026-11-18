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

import { QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { type AdminContext, type AdminDeps, nowOf, toDate } from './deps';
import { apiError } from './errors';
import { startJob } from './jobs';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import { getItem } from '../shared/db';
import { emitterRoleName } from '../shared/identity';
import type { BindingItem, CellItem, EmitterItem, IntervalItem } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { closeAttributes, reactivation, type Trace, updateExpression } from '../shared/registration';
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

async function readEmitter(deps: AdminDeps, cellId: string): Promise<{ cell?: CellItem; emitter?: EmitterItem }> {
  const cell = await getItem<CellItem>(deps.db, deps.config.tableName, keys.cell(cellId), true);
  if (cell === undefined) {
    return {};
  }
  const emitter = await getItem<EmitterItem>(deps.db, deps.config.tableName, keys.emitter(cell.accountId, cell.roleName), true);
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
  const { cell, emitter } = await readEmitter(deps, input.cellId);
  if (cell !== undefined && (cell.accountId !== input.accountId || cell.applicationId !== input.applicationId)) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the cell is registered with another account or application');
  }
  const emitterKey = keys.emitter(input.accountId, roleName);
  const cellKey = keys.cell(input.cellId);

  if (emitter === undefined) {
    const item: EmitterItem = {
      ...emitterKey,
      SK: 'META',
      cellId: input.cellId,
      applicationId: input.applicationId,
      accountId: input.accountId,
      roleName,
      status: 'ACTIVE',
      activeFrom: iso(nowMs),
      controlPlaneExecutionId: input.trace.executionId,
      controlPlaneOperatorId: input.trace.operatorId,
      createdBy: ctx.caller.roleArn,
      createdAt: iso(nowMs),
    };
    const cellItem: CellItem = {
      ...cellKey,
      SK: 'META',
      cellId: input.cellId,
      accountId: input.accountId,
      roleName,
      applicationId: input.applicationId,
    };
    await transact(deps, [
      { Put: { TableName: tableName, Item: cellItem } },
      {
        Put: {
          TableName: tableName,
          Item: { ...item, listType: 'EMITTER', listSort: input.cellId },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
    return item;
  }
  if (emitter.status === 'ACTIVE') {
    return emitter;
  }
  const { set, remove } = reactivation(emitter, nowMs, recountWindowHours, input.trace);
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
    update(tableName, cellKey, {}, ['expiresAt'], 'attribute_exists(PK)', {}, {}),
  ]);
  const out = { ...emitter, ...set } as Record<string, unknown>;
  for (const name of remove) {
    delete out[name];
  }
  return out as unknown as EmitterItem;
}

export async function getCellEmitter(deps: AdminDeps, cellId: string): Promise<EmitterItem> {
  const { emitter } = await readEmitter(deps, cellId);
  if (emitter === undefined) {
    throw apiError.notFound('no emitter is registered for this cell');
  }
  return emitter;
}

export async function deleteCellEmitter(deps: AdminDeps, cellId: string, trace: Trace): Promise<EmitterItem | undefined> {
  const { tableName, closeGraceMinutes, recountWindowHours } = deps.config;
  const { cell, emitter } = await readEmitter(deps, cellId);
  if (cell === undefined || emitter === undefined || emitter.status === 'CLOSING') {
    return emitter;
  }
  const close = closeAttributes(nowOf(deps), closeGraceMinutes, recountWindowHours, trace);
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
    update(tableName, keys.cell(cellId), { expiresAt: close.expiresAt }, [], 'attribute_exists(PK)', {}, {}),
  ]);
  return { ...emitter, ...close } as EmitterItem;
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
    emitters: (page.Items ?? []) as EmitterItem[],
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}

// ---------------------------------------------------------------------------
// Tenant bindings (spec §4.3)
// ---------------------------------------------------------------------------

/** The same update on both copies of a binding. */
function bindingUpdates(
  tableName: string,
  binding: BindingItem,
  set: Record<string, unknown>,
  remove: string[],
  condition: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
): TransactItem[] {
  return [
    update(tableName, keys.binding(binding.cellId, binding.tenantId), set, remove, condition, names, values),
    update(tableName, keys.bindingLookup(binding.tenantId, binding.applicationId, binding.cellId), set, remove, condition, names, values),
  ];
}

export async function putTenantBinding(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { cellId: string; tenantId: string; applicationId: string; billingAccount?: string; trace: Trace },
): Promise<{ binding: BindingItem; resendJobId?: string }> {
  const { tableName, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const { cell, emitter } = await readEmitter(deps, input.cellId);
  if (cell === undefined || emitter === undefined || emitter.status !== 'ACTIVE' || cell.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the cell has no ACTIVE emitter of this application');
  }
  const stored = await getItem<BindingItem>(deps.db, tableName, keys.binding(input.cellId, input.tenantId), true);
  if (stored !== undefined && stored.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the tenant is bound to this cell for another application');
  }
  const billingChanged = input.billingAccount !== undefined && input.billingAccount !== stored?.billingAccount;

  let binding: BindingItem;
  if (stored === undefined) {
    binding = {
      ...keys.binding(input.cellId, input.tenantId),
      cellId: input.cellId,
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      billingAccount: input.billingAccount,
      status: 'ACTIVE',
      activeFrom: iso(nowMs),
      controlPlaneExecutionId: input.trace.executionId,
      controlPlaneOperatorId: input.trace.operatorId,
      createdBy: ctx.caller.roleArn,
      createdAt: iso(nowMs),
    };
    await transact(deps, [
      { Put: { TableName: tableName, Item: binding, ConditionExpression: 'attribute_not_exists(PK)' } },
      {
        Put: {
          TableName: tableName,
          Item: { ...binding, ...keys.bindingLookup(input.tenantId, input.applicationId, input.cellId) },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
  } else if (stored.status === 'ACTIVE') {
    binding = stored;
    if (billingChanged) {
      await transact(
        deps,
        bindingUpdates(
          tableName,
          stored,
          { billingAccount: input.billingAccount },
          [],
          stored.billingAccount === undefined
            ? '#cs = :active AND attribute_not_exists(billingAccount)'
            : '#cs = :active AND billingAccount = :old',
          { '#cs': 'status' },
          stored.billingAccount === undefined ? { ':active': 'ACTIVE' } : { ':active': 'ACTIVE', ':old': stored.billingAccount },
        ),
      );
      binding = { ...stored, billingAccount: input.billingAccount };
    }
  } else {
    const { set, remove } = reactivation(stored, nowMs, recountWindowHours, input.trace);
    if (input.billingAccount !== undefined) {
      set.billingAccount = input.billingAccount;
    }
    await transact(
      deps,
      bindingUpdates(
        tableName,
        stored,
        set,
        remove,
        '#cs = :closing AND closedAt = :seen',
        { '#cs': 'status' },
        { ':closing': 'CLOSING', ':seen': stored.closedAt },
      ),
    );
    const out = { ...stored, ...set } as Record<string, unknown>;
    for (const name of remove) {
      delete out[name];
    }
    binding = out as unknown as BindingItem;
  }

  // A billing account just set unblocks the tenant's BLOCKED deliveries (spec §4.7).
  const resendJobId = billingChanged
    ? (await startJob(deps, ctx, 'RESEND_BLOCKED', { tenantId: input.tenantId, applicationId: input.applicationId })).jobId
    : undefined;
  return { binding, resendJobId };
}

export async function getTenantBinding(deps: AdminDeps, cellId: string, tenantId: string): Promise<BindingItem> {
  const item = await getItem<BindingItem>(deps.db, deps.config.tableName, keys.binding(cellId, tenantId), true);
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
  const stored = await getItem<BindingItem>(deps.db, tableName, keys.binding(cellId, tenantId), true);
  if (stored === undefined || stored.status === 'CLOSING') {
    return stored;
  }
  const close = closeAttributes(nowOf(deps), closeGraceMinutes, recountWindowHours, trace);
  await transact(deps, bindingUpdates(tableName, stored, close, [], '#cs = :active', { '#cs': 'status' }, { ':active': 'ACTIVE' }));
  return { ...stored, ...close } as BindingItem;
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
    bindings: (page.Items ?? []) as BindingItem[],
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}
