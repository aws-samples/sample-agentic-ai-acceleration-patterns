// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Registrations (spec §3.4, §4.2, §4.3): what the control plane's vendor
 * hooks write. Every operation is idempotent, because hooks run again on
 * updates, retries and cleanups: `Put*` reaches the same item whatever its
 * prior state, and `Delete*` succeeds on a missing or closing item.
 *
 * An emitter is two items: `ROLE#<account>#<role>` (status and
 * intervals, what ingest reads) and `EMITTER#<emitterId>` (which role an
 * emitter id has). A binding is two copies: under the emitter (what ingest reads) and
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
import type { BindingItem, EmitterItem, EmitterRoleItem, IntervalItem } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { closeAttributes, reactivation, type Trace, updateExpression } from '../shared/registration';
import { isConditionFailure } from '../shared/retry';
import { iso } from '../shared/time';
import type { EmitterSummary, Interval, TenantBindingSummary } from '../smithy/metering/typescript-ssdk-codegen/src';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

const intervalsOut = (intervals: IntervalItem[] | undefined): Interval[] | undefined =>
  intervals?.map((interval) => ({
    activeFrom: toDate(interval.activeFrom),
    closedAt: toDate(interval.closedAt),
    closedByExecutionId: interval.closedByExecutionId,
    closedByOperatorId: interval.closedByOperatorId,
  }));

export function emitterOut(item: EmitterRoleItem): EmitterSummary {
  return {
    emitterId: item.emitterId,
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
    emitterId: item.emitterId,
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
// Emitters (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * A registration item that TTL has not removed yet but whose `expiresAt` has
 * passed counts as absent. DynamoDB deletes expired items late, and deletes
 * the two items of a pair separately, so every read treats them alike and
 * every write repairs the other item of the pair.
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

/** The id item may be written only where it is absent, expired, or already this account's and application's. */
function emitterPut(tableName: string, item: EmitterItem, nowMs: number): TransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK) OR expiresAt <= :now OR (accountId = :a AND applicationId = :app)',
      ExpressionAttributeValues: { ':now': nowSeconds(nowMs), ':a': item.accountId, ':app': item.applicationId },
    },
  };
}

function emitterItemOf(emitter: EmitterRoleItem): EmitterItem {
  return {
    ...keys.emitter(emitter.emitterId),
    SK: 'META',
    emitterId: emitter.emitterId,
    accountId: emitter.accountId,
    roleName: emitter.roleName,
    applicationId: emitter.applicationId,
    ...(emitter.expiresAt !== undefined ? { expiresAt: emitter.expiresAt } : {}),
  };
}

/** The live id item and the live emitter role item it names. */
async function readEmitter(deps: AdminDeps, emitterId: string, nowMs: number): Promise<{ idItem?: EmitterItem; emitter?: EmitterRoleItem }> {
  const idItem = live(await getItem<EmitterItem>(deps.db, deps.config.tableName, keys.emitter(emitterId), true), nowMs);
  if (idItem === undefined) {
    return {};
  }
  const emitter = live(
    await getItem<EmitterRoleItem>(deps.db, deps.config.tableName, keys.emitterRole(idItem.accountId, idItem.roleName), true),
    nowMs,
  );
  return { idItem, emitter };
}

export async function putEmitter(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { emitterId: string; applicationId: string; accountId: string; trace: Trace },
): Promise<EmitterRoleItem> {
  const { tableName, fleetName, recountWindowHours } = deps.config;
  if (deps.config.blockedAccountIds.includes(input.accountId)) {
    throw apiError.conflict('ACCOUNT_NOT_ALLOWED', 'an emitter may not live in the metering account or in an account a bus is shared with');
  }
  const roleName = emitterRoleName(fleetName, input.emitterId);
  const nowMs = nowOf(deps);
  const emitterKey = keys.emitterRole(input.accountId, roleName);
  const idItem = live(await getItem<EmitterItem>(deps.db, tableName, keys.emitter(input.emitterId), true), nowMs);
  if (idItem !== undefined && (idItem.accountId !== input.accountId || idItem.applicationId !== input.applicationId)) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the emitter is registered with another account or application');
  }
  // Read by the requested key, so an emitter whose id item TTL already removed is still found.
  const emitter = live(await getItem<EmitterRoleItem>(deps.db, tableName, emitterKey, true), nowMs);

  if (emitter === undefined) {
    const item = {
      ...emitterKey,
      SK: 'META' as const,
      emitterId: input.emitterId,
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
      listSort: input.emitterId,
    } satisfies EmitterRoleItem & { listType: string; listSort: string };
    await transact(deps, [
      emitterPut(tableName, emitterItemOf(item), nowMs),
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
    if (idItem === undefined) {
      await transact(deps, [emitterPut(tableName, emitterItemOf(emitter), nowMs)]);
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
    emitterPut(tableName, emitterItemOf(next), nowMs),
  ]);
  return next;
}

export async function getEmitter(deps: AdminDeps, emitterId: string): Promise<EmitterRoleItem> {
  const { emitter } = await readEmitter(deps, emitterId, nowOf(deps));
  if (emitter === undefined) {
    throw apiError.notFound('no emitter is registered with this id');
  }
  return emitter;
}

export async function deleteEmitter(deps: AdminDeps, emitterId: string, trace: Trace): Promise<EmitterRoleItem | undefined> {
  const { tableName, closeGraceMinutes, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const { idItem, emitter } = await readEmitter(deps, emitterId, nowMs);
  if (idItem === undefined || emitter === undefined || emitter.status === 'CLOSING') {
    return emitter;
  }
  const close = closeAttributes(nowMs, closeGraceMinutes, recountWindowHours, trace);
  const next = applied(emitter, close, []);
  await transact(deps, [
    update(
      tableName,
      keys.emitterRole(idItem.accountId, idItem.roleName),
      close,
      [],
      '#cs = :active',
      { '#cs': 'status' },
      { ':active': 'ACTIVE' },
    ),
    emitterPut(tableName, emitterItemOf(next), nowMs),
  ]);
  return next;
}

export async function listEmitters(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ emitters: EmitterRoleItem[]; nextToken?: string }> {
  const query = 'ListEmitters';
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
    // An item past its expiresAt is absent, as Get* treats it.
    emitters: ((page.Items ?? []) as EmitterRoleItem[]).filter((item) => live(item, nowOf(deps)) !== undefined),
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}

// ---------------------------------------------------------------------------
// Tenant bindings (spec §4.3)
// ---------------------------------------------------------------------------

/**
 * Writes a binding: the emitter copy (what ingest reads) under `condition`,
 * and the tenant copy as a full put, so a copy TTL removed early is
 * rewritten rather than failing the call.
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
        Item: { ...next, ...keys.binding(next.emitterId, next.tenantId) },
        ConditionExpression: condition,
        ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
        ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
      },
    },
    { Put: { TableName: tableName, Item: { ...next, ...keys.bindingLookup(next.tenantId, next.applicationId, next.emitterId) } } },
  ];
}

export async function putTenantBinding(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { emitterId: string; tenantId: string; applicationId: string; billingAccount?: string; trace: Trace },
): Promise<{ binding: BindingItem; resendJobId?: string }> {
  const { tableName, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const { idItem, emitter } = await readEmitter(deps, input.emitterId, nowMs);
  if (idItem === undefined || emitter === undefined || emitter.status !== 'ACTIVE' || idItem.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the emitter is not ACTIVE or is of another application');
  }
  const stored = live(await getItem<BindingItem>(deps.db, tableName, keys.binding(input.emitterId, input.tenantId), true), nowMs);
  if (stored !== undefined && stored.applicationId !== input.applicationId) {
    throw apiError.conflict('PLACEMENT_MISMATCH', 'the tenant is bound to this emitter for another application');
  }
  const billingChanged = input.billingAccount !== undefined && input.billingAccount !== stored?.billingAccount;
  // A resend that could not be started last time is started now.
  const resend = billingChanged || stored?.resendPending === true;
  const billing = billingChanged ? { billingAccount: input.billingAccount, resendPending: true } : {};

  let binding: BindingItem;
  if (stored === undefined) {
    binding = {
      ...keys.binding(input.emitterId, input.tenantId),
      emitterId: input.emitterId,
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
    await transact(
      deps,
      bindingWrites(tableName, binding, 'attribute_not_exists(PK) OR expiresAt <= :now', {}, { ':now': nowSeconds(nowMs) }),
    );
  } else if (stored.status === 'ACTIVE') {
    binding = applied(stored, billing, []);
    if (billingChanged) {
      await transact(
        deps,
        bindingWrites(
          tableName,
          binding,
          stored.billingAccount === undefined
            ? '#cs = :active AND attribute_not_exists(billingAccount)'
            : '#cs = :active AND billingAccount = :old',
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
      bindingWrites(
        tableName,
        binding,
        '#cs = :closing AND closedAt = :seen',
        { '#cs': 'status' },
        { ':closing': 'CLOSING', ':seen': stored.closedAt },
      ),
    );
  }

  if (!resend) {
    return { binding };
  }
  // A billing account just set unblocks the tenant's BLOCKED deliveries (spec §4.7).
  const job = await startJob(deps, ctx, 'RESEND_BLOCKED', { tenantId: input.tenantId, applicationId: input.applicationId });
  // Clear the flag alone, on each copy that still holds it, so a delete or
  // a billing change committed in between is left as it is.
  for (const key of [
    keys.binding(binding.emitterId, binding.tenantId),
    keys.bindingLookup(binding.tenantId, binding.applicationId, binding.emitterId),
  ]) {
    try {
      await deps.db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: 'REMOVE resendPending',
          // Only this call's flag: a newer billing change keeps its own.
          ConditionExpression: 'resendPending = :true AND billingAccount = :b',
          ExpressionAttributeValues: { ':true': true, ':b': binding.billingAccount },
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

export async function getTenantBinding(deps: AdminDeps, emitterId: string, tenantId: string): Promise<BindingItem> {
  const item = live(await getItem<BindingItem>(deps.db, deps.config.tableName, keys.binding(emitterId, tenantId), true), nowOf(deps));
  if (item === undefined) {
    throw apiError.notFound('no such binding');
  }
  return item;
}

export async function deleteTenantBinding(
  deps: AdminDeps,
  emitterId: string,
  tenantId: string,
  trace: Trace,
): Promise<BindingItem | undefined> {
  const { tableName, closeGraceMinutes, recountWindowHours } = deps.config;
  const nowMs = nowOf(deps);
  const stored = live(await getItem<BindingItem>(deps.db, tableName, keys.binding(emitterId, tenantId), true), nowMs);
  if (stored === undefined || stored.status === 'CLOSING') {
    return stored;
  }
  const next = applied(stored, closeAttributes(nowMs, closeGraceMinutes, recountWindowHours, trace), []);
  await transact(deps, bindingWrites(tableName, next, '#cs = :active', { '#cs': 'status' }, { ':active': 'ACTIVE' }));
  return next;
}

export async function listTenantBindings(
  deps: AdminDeps,
  emitterId: string,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ bindings: BindingItem[]; nextToken?: string }> {
  const query = `ListTenantBindings#${emitterId}`;
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)',
      ExpressionAttributeValues: { ':pk': keys.emitterPk(emitterId), ':t': 'TENANT#' },
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  return {
    bindings: ((page.Items ?? []) as BindingItem[]).filter((item) => live(item, nowOf(deps)) !== undefined),
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}
