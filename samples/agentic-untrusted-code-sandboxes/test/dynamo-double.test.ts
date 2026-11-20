// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The double is test machinery, so it gets its own checks: a condition it
// evaluates wrongly would let a race test pass for the wrong reason (ADR-0036).

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDouble } from './dynamo-double';
import { rowItem } from './harness';
import { Registry } from '../src/tool/registry';

const T = 'tenant-a';
const now = 1_700_000_000_000;

function setup() {
  const db = new DynamoDouble();
  return { db, registry: new Registry(db.client, 'registry') };
}

describe('registry over the in-memory DynamoDB', () => {
  test('takeOver creates a row only when none exists, and only from the version and nonce read', async () => {
    const { db, registry } = setup();
    const base = { tenantId: T, backend: 'microvm' as const, now, startCapMs: 20_000, sandboxMaxLifeMs: 3_600_000 };
    const first = await registry.takeOver({ ...base, nonce: 'n1' }, undefined);
    expect(first).toMatchObject({ state: 'STARTING', version: 1, leaseUntil: now + 20_000, expiresAt: now + 3_600_000 });
    expect(first?.ttlAt).toBe((now + 7_200_000) / 1000);
    // a second creator that read "missing" loses
    expect(await registry.takeOver({ ...base, nonce: 'n2' }, undefined)).toBeUndefined();
    // a stale version loses, the current one wins and bumps
    expect(await registry.takeOver({ ...base, nonce: 'n3' }, { ...(first as object), version: 7 } as never)).toBeUndefined();
    const second = await registry.takeOver({ ...base, nonce: 'n4' }, first);
    expect(second?.version).toBe(2);
    // the same version with a different nonce (a row deleted and recreated) loses
    expect(await registry.takeOver({ ...base, nonce: 'n5' }, { ...(first as object), version: 2, nonce: 'other' } as never)).toBeUndefined();
    expect(db.row('TENANT#tenant-a', 'SANDBOX#microvm')?.nonce).toBe('n4');
  });

  test('a row with no state is missing: takeOver replaces it', async () => {
    const { db, registry } = setup();
    db.seed({ PK: 'TENANT#tenant-a', SK: 'SANDBOX#microvm', handle: 'half-written' });
    expect(await registry.get(T, 'microvm')).toBeUndefined();
    const row = await registry.takeOver({ tenantId: T, backend: 'microvm', nonce: 'n', now, startCapMs: 1000, sandboxMaxLifeMs: 1000 }, undefined);
    expect(row?.version).toBe(1);
  });

  test('update never creates a row and fails on a moved version', async () => {
    const { db, registry } = setup();
    expect(await registry.update(T, 'microvm', 1, { state: 'READY' })).toBeUndefined();
    expect(db.items.size).toBe(0);
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'STARTING', version: 3 }, now));
    expect(await registry.update(T, 'microvm', 2, { state: 'READY' })).toBeUndefined();
    expect(await registry.update(T, 'microvm', 3, { state: 'READY', handle: 'h' })).toBe(4);
    expect(await registry.get(T, 'microvm')).toMatchObject({ state: 'READY', handle: 'h', version: 4 });
  });

  test('touch moves lastUsedAt forward only, for the same handle, and never creates a row', async () => {
    const { db, registry } = setup();
    expect(await registry.touch(T, 'microvm', 'h', now)).toBeUndefined();
    expect(db.items.size).toBe(0);
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'READY', handle: 'h', lastUsedAt: now + 10, version: 1 }, now));
    expect(await registry.touch(T, 'microvm', 'h', now + 5)).toBeUndefined();
    expect(await registry.touch(T, 'microvm', 'other', now + 20)).toBeUndefined();
    expect(await registry.touch(T, 'microvm', 'h', now + 20)).toBe(2);
    expect((await registry.get(T, 'microvm'))?.lastUsedAt).toBe(now + 20);
  });

  test('markStart is conditioned on the lastUsedAt read and adds the gap once', async () => {
    const { db, registry } = setup();
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'READY', handle: 'h', version: 1 }, now));
    const read = (await registry.get(T, 'microvm'))!;
    const marked = await registry.markStart(read, now + 100, 40);
    expect(marked).toMatchObject({ lastUsedAt: now + 100, suspendedMs: 40, version: 2 });
    // a second caller holding the old read loses
    expect(await registry.markStart(read, now + 200, 40)).toBeUndefined();
    const again = await registry.markStart(marked!, now + 200, 5);
    expect(again).toMatchObject({ lastUsedAt: now + 200, suspendedMs: 45, version: 3 });
  });

  test('markStart refuses a row that is no longer READY for the handle', async () => {
    const { db, registry } = setup();
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'STOPPING', handle: 'h', version: 1 }, now));
    const read = (await registry.get(T, 'microvm'))!;
    expect(await registry.markStart({ ...read, state: 'READY' }, now, undefined)).toBeUndefined();
  });

  test('delete is conditioned on the version', async () => {
    const { db, registry } = setup();
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'READY', handle: 'h', version: 2 }, now));
    expect(await registry.delete(T, 'microvm', 1)).toBe(false);
    expect(await registry.delete(T, 'microvm', 2)).toBe(true);
    expect(await registry.delete(T, 'microvm', 2)).toBe(false);
  });

  test('scan pages through every row of every tenant', async () => {
    const { db, registry } = setup();
    db.pageSize = 2;
    for (const t of ['a', 'b', 'c']) {
      for (const b of ['microvm', 'nitro'] as const) db.seed(rowItem({ tenantId: t, backend: b, state: 'READY', handle: `${t}-${b}` }, now));
    }
    db.seed({ PK: 'TENANT#d', SK: 'SANDBOX#microvm' });
    const seen: string[] = [];
    for await (const r of registry.scan()) seen.push(`${r.tenantId}/${r.backend}`);
    expect(seen).toHaveLength(6);
    expect(db.log.filter((l) => l.op === 'scan').length).toBe(4);
  });

  test('the double rejects an expression it cannot evaluate', async () => {
    const { db } = setup();
    db.seed(rowItem({ tenantId: T, backend: 'microvm', state: 'READY', handle: 'h' }, now));
    await expect(db.client.send(new UpdateCommand({
      TableName: 't', Key: { PK: 'TENANT#tenant-a', SK: 'SANDBOX#microvm' }, UpdateExpression: 'REMOVE handle',
    }))).rejects.toThrow(/expected SET/);
    await expect(db.client.send(new UpdateCommand({
      TableName: 't',
      Key: { PK: 'TENANT#tenant-a', SK: 'SANDBOX#microvm' },
      UpdateExpression: 'SET #a = :a',
      ConditionExpression: 'contains(handle, :a)',
      ExpressionAttributeNames: { '#a': 'x' },
      ExpressionAttributeValues: { ':a': 1 },
    }))).rejects.toThrow(/dynamo double/);
  });
});
