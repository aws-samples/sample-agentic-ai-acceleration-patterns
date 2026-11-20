// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sandbox registry (spec §4.1, ADR-0005, ADR-0032). Every write is
 * conditional, and every method that can lose a race reports it as a value
 * (`undefined` or `false`), never as an exception: the callers re-read and
 * decide again. The tool reaches the table with the tool tenant role (its
 * `dynamodb:LeadingKeys` condition limits it to one tenant's rows); the
 * reaper, the drain and the offboard function reach it with the reaper role.
 */

import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BACKEND_NAMES, type BackendName, type RegistryRow, type RowState } from '../backend';
import { REGISTRY, registryPk, registrySk, SANDBOX_KEY_PREFIX, TENANT_KEY_PREFIX } from '../env';

const R = REGISTRY;

/** Fields a writer sets on a `STARTING` row it takes over (spec §4.1 step 2). */
export interface NewRow {
  readonly tenantId: string;
  readonly backend: BackendName;
  readonly nonce: string;
  readonly now: number;
  readonly startCapMs: number;
  readonly sandboxMaxLifeMs: number;
}

/** Attributes a caller may change on a row it holds a version of. */
export interface RowPatch {
  readonly state?: RowState;
  readonly handle?: string;
  readonly address?: string;
  readonly bootId?: string;
  readonly retryAt?: number;
}

/** Whether DynamoDB refused a conditional write. */
export function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function states(): string[] {
  return ['STARTING', 'READY', 'STOPPING', 'FAILED'];
}

/** A row from an item, or undefined for an item with no valid `state` (a partial write counts as missing, spec §4.1). */
export function rowFromItem(item: Record<string, unknown> | undefined): RegistryRow | undefined {
  if (item === undefined) return undefined;
  const pk = item[R.PK];
  const sk = item[R.SK];
  const state = item[R.STATE];
  if (typeof pk !== 'string' || typeof sk !== 'string' || !pk.startsWith(TENANT_KEY_PREFIX) || !sk.startsWith(SANDBOX_KEY_PREFIX)) {
    return undefined;
  }
  const backend = BACKEND_NAMES.find((b) => b === sk.slice(SANDBOX_KEY_PREFIX.length));
  if (backend === undefined || typeof state !== 'string' || !states().includes(state)) return undefined;
  const str = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : undefined);
  const num = (k: string) => (typeof item[k] === 'number' ? (item[k] as number) : undefined);
  const nonce = str(R.NONCE);
  const createdAt = num(R.CREATED_AT);
  const expiresAt = num(R.EXPIRES_AT);
  const version = num(R.VERSION);
  if (nonce === undefined || createdAt === undefined || expiresAt === undefined || version === undefined) return undefined;
  return {
    tenantId: pk.slice(TENANT_KEY_PREFIX.length),
    backend,
    handle: str(R.HANDLE),
    address: str(R.ADDRESS),
    nonce,
    bootId: str(R.BOOT_ID),
    state: state as RowState,
    retryAt: num(R.RETRY_AT),
    createdAt,
    lastUsedAt: num(R.LAST_USED_AT),
    leaseUntil: num(R.LEASE_UNTIL),
    suspendedMs: num(R.SUSPENDED_MS),
    expiresAt,
    ttlAt: num(R.TTL_AT) ?? Math.floor((expiresAt + 3_600_000) / 1000),
    version,
  };
}

function keyOf(tenantId: string, backend: BackendName): Record<string, string> {
  return { [R.PK]: registryPk(tenantId), [R.SK]: registrySk(backend) };
}

export class Registry {
  public constructor(private readonly client: DynamoDBDocumentClient, private readonly table: string) {}

  /** A strongly consistent read; undefined when there is no row or it has no valid `state`. */
  public async get(tenantId: string, backend: BackendName): Promise<RegistryRow | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.table, Key: keyOf(tenantId, backend), ConsistentRead: true }));
    return rowFromItem(out.Item);
  }

  /** Every row of every tenant (the reaper role only), paged. */
  public async *scan(): AsyncIterable<RegistryRow> {
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.client.send(new ScanCommand({ TableName: this.table, ConsistentRead: true, ExclusiveStartKey: start }));
      for (const item of out.Items ?? []) {
        const row = rowFromItem(item);
        if (row !== undefined) yield row;
      }
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
  }

  /**
   * Spec §4.1 step 2: put a `STARTING` row with a new nonce when the row is
   * missing or still the one the caller read. `prev` is that row. The
   * condition also names the row's nonce, which is unique per start, so a row
   * deleted and recreated with the same version number is not taken over by
   * mistake. Returns the new row, or undefined when another caller won.
   */
  public async takeOver(next: NewRow, prev: RegistryRow | undefined): Promise<RegistryRow | undefined> {
    const expiresAt = next.now + next.sandboxMaxLifeMs;
    const version = (prev?.version ?? 0) + 1;
    const item = {
      ...keyOf(next.tenantId, next.backend),
      [R.NONCE]: next.nonce,
      [R.STATE]: 'STARTING',
      [R.CREATED_AT]: next.now,
      [R.LEASE_UNTIL]: next.now + next.startCapMs,
      [R.EXPIRES_AT]: expiresAt,
      [R.TTL_AT]: Math.floor((expiresAt + 3_600_000) / 1000),
      [R.VERSION]: version,
    };
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: item,
        ...(prev === undefined
          ? { ConditionExpression: 'attribute_not_exists(#state)', ExpressionAttributeNames: { '#state': R.STATE } }
          : {
            ConditionExpression: '#version = :v AND #nonce = :n',
            ExpressionAttributeNames: { '#version': R.VERSION, '#nonce': R.NONCE },
            ExpressionAttributeValues: { ':v': prev.version, ':n': prev.nonce },
          }),
      }));
    } catch (error) {
      if (isConditionFailure(error)) return undefined;
      throw error;
    }
    const row = rowFromItem(item);
    if (row === undefined) throw new Error('registry: a new row failed its own check');
    return row;
  }

  /**
   * Writes `patch` on the row the caller read at `version`, bumping the
   * version. Returns the new version, or undefined when the row moved or is
   * gone (a conditional update never creates a row).
   */
  public async update(tenantId: string, backend: BackendName, version: number, patch: RowPatch): Promise<number | undefined> {
    const attrs: Record<string, string | number> = {};
    if (patch.state !== undefined) attrs[R.STATE] = patch.state;
    if (patch.handle !== undefined) attrs[R.HANDLE] = patch.handle;
    if (patch.address !== undefined) attrs[R.ADDRESS] = patch.address;
    if (patch.bootId !== undefined) attrs[R.BOOT_ID] = patch.bootId;
    if (patch.retryAt !== undefined) attrs[R.RETRY_AT] = patch.retryAt;
    attrs[R.VERSION] = version + 1;
    const names: Record<string, string> = { '#cv': R.VERSION };
    const values: Record<string, unknown> = { ':v': version };
    const sets = Object.entries(attrs).map(([k, v], i) => {
      names[`#a${i}`] = k;
      values[`:a${i}`] = v;
      return `#a${i} = :a${i}`;
    });
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: keyOf(tenantId, backend),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#cv = :v',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
      return version + 1;
    } catch (error) {
      if (isConditionFailure(error)) return undefined;
      throw error;
    }
  }

  /**
   * The start mark (spec §3.8, §4.1): when a call first reaches a `READY`
   * sandbox at `now`, set `lastUsedAt` = `now`, conditioned on the value the
   * caller read, so each idle gap is added to `suspendedMs` once. The row
   * must still be the `READY` row of `handle`. Returns the row after the
   * write, or undefined when the condition failed.
   */
  public async markStart(row: RegistryRow, now: number, suspendGapMs: number | undefined): Promise<RegistryRow | undefined> {
    const names: Record<string, string> = {
      '#last': R.LAST_USED_AT, '#version': R.VERSION, '#handle': R.HANDLE, '#state': R.STATE,
    };
    const values: Record<string, unknown> = { ':t': now, ':one': 1, ':h': row.handle, ':ready': 'READY' };
    let update = 'SET #last = :t, #version = #version + :one';
    if (suspendGapMs !== undefined) {
      names['#susp'] = R.SUSPENDED_MS;
      values[':gap'] = suspendGapMs;
      values[':zero'] = 0;
      update += ', #susp = if_not_exists(#susp, :zero) + :gap';
    }
    let condition = 'attribute_exists(PK) AND #handle = :h AND #state = :ready AND ';
    if (row.lastUsedAt === undefined) {
      condition += 'attribute_not_exists(#last)';
    } else {
      condition += '#last = :read';
      values[':read'] = row.lastUsedAt;
    }
    try {
      const out = await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: keyOf(row.tenantId, row.backend),
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }));
      return rowFromItem(out.Attributes);
    } catch (error) {
      if (isConditionFailure(error)) return undefined;
      throw error;
    }
  }

  /**
   * Step 4 (spec §4.1): move `lastUsedAt` forward to the end of a run. Writes
   * only when the row still exists, still holds `handle`, and `lastUsedAt` is
   * older, so a deleted or replaced row is not recreated and the value only
   * moves forward, whichever call wrote last. Returns the new version, or
   * undefined when nothing was written.
   */
  public async touch(tenantId: string, backend: BackendName, handle: string, end: number): Promise<number | undefined> {
    try {
      const out = await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: keyOf(tenantId, backend),
        UpdateExpression: 'SET #last = :end, #version = #version + :one',
        ConditionExpression: 'attribute_exists(PK) AND #handle = :h AND #last < :end',
        ExpressionAttributeNames: { '#last': R.LAST_USED_AT, '#version': R.VERSION, '#handle': R.HANDLE },
        ExpressionAttributeValues: { ':end': end, ':one': 1, ':h': handle },
        ReturnValues: 'UPDATED_NEW',
      }));
      const v = out.Attributes?.[R.VERSION];
      return typeof v === 'number' ? v : undefined;
    } catch (error) {
      if (isConditionFailure(error)) return undefined;
      throw error;
    }
  }

  /** Deletes the row the caller holds at `version`. False when it moved or is already gone. */
  public async delete(tenantId: string, backend: BackendName, version: number): Promise<boolean> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.table,
        Key: keyOf(tenantId, backend),
        ConditionExpression: '#version = :v',
        ExpressionAttributeNames: { '#version': R.VERSION },
        ExpressionAttributeValues: { ':v': version },
      }));
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}
