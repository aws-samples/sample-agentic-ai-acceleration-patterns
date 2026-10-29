// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { ConflictError, InvalidInputError, NotFoundError } from '../../src/shared/errors';
import { backoffDelay, DynamoDBRegistry, type TenantRecord } from '../../src/shared/registry';

const TABLE = 'TenantRegistry';
// The mock is typed loosely: a nested @smithy/types (pulled by @aws-sdk/core)
// differs from the top-level one, so the lib-dynamodb command generics do not
// unify through aws-sdk-client-mock. `any` at this boundary keeps the tests
// readable; the registry under test is fully typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ddb: any = mockClient(DynamoDBDocumentClient as any);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The jest matchers (toHaveReceivedCommand*) take a command class and hit the
// same duplicate-@smithy/types generic mismatch; alias the classes through
// `any` so the matcher accepts them. Runtime behaviour is unchanged.
/* eslint-disable @typescript-eslint/no-explicit-any */
const AnyBatchGet = BatchGetCommand as any;
const AnyScan = ScanCommand as any;
const AnyDelete = DeleteCommand as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

function record(tenantId: string, over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId,
    name: `tenant ${tenantId}`,
    status: 'ACTIVE',
    topology: 'shared-pool',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...over,
  };
}

function item(r: TenantRecord): Record<string, unknown> {
  return { PK: `TENANT#${r.tenantId}`, SK: 'META', ...r };
}

beforeEach(() => ddb.reset());

describe('DynamoDBRegistry (spec §4, ADR-0002)', () => {
  const registry = () => new DynamoDBRegistry(TABLE, client);

  it('get returns the record when present (§4.1)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    ddb.on(GetCommand).resolves({ Item: item(r) });
    expect(await registry().get(r.tenantId)).toEqual(r);
  });

  it('get returns undefined when absent (§4.1)', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await registry().get('missing')).toBeUndefined();
  });

  it('batchGet returns the found records and retries UnprocessedKeys (§8 tenant lookup)', async () => {
    const a = record('01ARZ3NDEKTSV4RRFFQ69G5FA1');
    const b = record('01ARZ3NDEKTSV4RRFFQ69G5FB2');
    // First call returns a and leaves b unprocessed; second call returns b.
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { [TABLE]: [item(a)] }, UnprocessedKeys: { [TABLE]: { Keys: [{ PK: `TENANT#${b.tenantId}`, SK: 'META' }] } } })
      .resolvesOnce({ Responses: { [TABLE]: [item(b)] } });
    const got = await registry().batchGet([a.tenantId, b.tenantId]);
    expect(got).toEqual(expect.arrayContaining([a, b]));
    expect(got).toHaveLength(2);
    expect(ddb).toHaveReceivedCommandTimes(AnyBatchGet, 2);
  });

  it('getByUserPoolId returns undefined on 0 hits (§4.2)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await registry().getByUserPoolId('pool_x')).toBeUndefined();
  });

  it('getByUserPoolId returns the record on 1 hit, reading the item for status (§4.2)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FA3', { userPoolId: 'pool_1', status: 'DELETING' });
    ddb.on(QueryCommand).resolves({ Items: [{ tenantId: r.tenantId }] });
    ddb.on(GetCommand).resolves({ Item: item(r) });
    expect(await registry().getByUserPoolId('pool_1')).toEqual(r);
  });

  it('getByUserPoolId throws on 2 hits (corruption, §4.2)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ tenantId: 'a' }, { tenantId: 'b' }] });
    await expect(registry().getByUserPoolId('pool_1')).rejects.toThrow(/more than one tenant/);
  });

  it('list paginates with an opaque nextToken (§4.3)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FA4');
    ddb.on(ScanCommand).resolves({ Items: [item(r)], LastEvaluatedKey: { PK: `TENANT#${r.tenantId}`, SK: 'META' } });
    const page = await registry().list();
    expect(page.items).toEqual([r]);
    expect(page.nextToken).toBeDefined();
    // The token round-trips back into ExclusiveStartKey.
    ddb.on(ScanCommand).resolves({ Items: [] });
    await registry().list(page.nextToken);
    expect(ddb).toHaveReceivedCommandWith(AnyScan, {
      ExclusiveStartKey: { PK: `TENANT#${r.tenantId}`, SK: 'META' },
    });
  });

  it('list rejects an invalid nextToken (§4.3)', async () => {
    await expect(registry().list('not-base64-json')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('create fails with ConflictError when the id exists', async () => {
    const err = new Error('exists');
    err.name = 'ConditionalCheckFailedException';
    ddb.on(PutCommand).rejects(err);
    await expect(registry().create(record('01ARZ3NDEKTSV4RRFFQ69G5FA5'))).rejects.toBeInstanceOf(ConflictError);
  });

  it('activate flips PROVISIONING to ACTIVE and writes the provisioned fields (ADR-0021, §5.1)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FP1', {
      status: 'ACTIVE',
      userPoolId: 'pool_1',
      appClientId: 'client_1',
      issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/pool_1',
    });
    ddb.on(UpdateCommand).resolves({ Attributes: item(r) });
    const got = await registry().activate(r.tenantId, {
      userPoolId: 'pool_1',
      appClientId: 'client_1',
      issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/pool_1',
    });
    expect(got.status).toBe('ACTIVE');
    expect(got.userPoolId).toBe('pool_1');
    const call = ddb.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #s = :provisioning');
    expect(input.UpdateExpression).toContain('#s = :active');
    expect(input.UpdateExpression).toContain('#userPoolId = :userPoolId');
    expect(input.UpdateExpression).toContain('#appClientId = :appClientId');
    expect(input.UpdateExpression).toContain('#issuer = :issuer');
    expect(input.ReturnValues).toBe('ALL_NEW');
  });

  it('activate writes the API key id and value with the Cognito fields (ADR-0025)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { PK: 'TENANT#x', SK: 'META', status: 'ACTIVE' } });
    await registry().activate('01ARZ3NDEKTSV4RRFFQ69G5FP3', { groupName: 't-x', apiKeyId: 'key-1', apiKeyValue: 'value-1' });
    const input = ddb.commandCalls(UpdateCommand).at(-1).args[0].input;
    expect(input.UpdateExpression).toContain('#apiKeyId = :apiKeyId');
    expect(input.UpdateExpression).toContain('#apiKeyValue = :apiKeyValue');
    expect(input.ExpressionAttributeValues[':apiKeyId']).toBe('key-1');
    expect(input.ExpressionAttributeValues[':apiKeyValue']).toBe('value-1');
  });

  it('activate omits undefined provisioned fields from the update (ADR-0021)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FP2', { status: 'ACTIVE', groupName: 't-01ARZ3NDEKTSV4RRFFQ69G5FP2' });
    ddb.on(UpdateCommand).resolves({ Attributes: item(r) });
    // Only groupName is defined (shared-pool-multi-tenant); pool fields are undefined.
    await registry().activate(r.tenantId, { groupName: `t-${r.tenantId}`, userPoolId: undefined });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('#groupName = :groupName');
    expect(input.UpdateExpression).not.toContain('userPoolId');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':userPoolId');
    expect(input.ExpressionAttributeNames).not.toHaveProperty('#userPoolId');
  });

  it('activate throws ConflictError when the row is not PROVISIONING (ADR-0021)', async () => {
    const err = new Error('not provisioning');
    err.name = 'ConditionalCheckFailedException';
    ddb.on(UpdateCommand).rejects(err);
    await expect(
      registry().activate('01ARZ3NDEKTSV4RRFFQ69G5FP3', { groupName: 't-x' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      registry().activate('01ARZ3NDEKTSV4RRFFQ69G5FP3', { groupName: 't-x' }),
    ).rejects.toThrow('is not PROVISIONING');
  });

  it('markDeleting throws NotFoundError when the tenant does not exist (R-11)', async () => {
    const err = new Error('nope');
    err.name = 'ConditionalCheckFailedException';
    ddb.on(UpdateCommand).rejects(err);
    await expect(registry().markDeleting('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('markDeleting returns the DELETING record on success (R-11)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FA6', { status: 'DELETING' });
    ddb.on(UpdateCommand).resolves({ Attributes: item(r) });
    const got = await registry().markDeleting(r.tenantId);
    expect(got.status).toBe('DELETING');
  });

  it('delete removes the item; a missing item is not an error', async () => {
    ddb.on(DeleteCommand).resolves({});
    await expect(registry().delete('01ARZ3NDEKTSV4RRFFQ69G5FA7')).resolves.toBeUndefined();
    expect(ddb).toHaveReceivedCommandWith(AnyDelete, { TableName: TABLE, Key: { PK: 'TENANT#01ARZ3NDEKTSV4RRFFQ69G5FA7', SK: 'META' } });
  });

  describe('first-admin slot (ADR-0032, mounting spec M-R-8, M-R-9)', () => {
    const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FS1';
    const EMAIL = 'success+admin@simulator.amazonses.com';
    const conditionFailure = () => {
      const err = new Error('condition');
      err.name = 'ConditionalCheckFailedException';
      return err;
    };

    it('claimFirstAdmin is ONE conditional write guarded by attribute_not_exists(firstAdminEmail)', async () => {
      ddb.on(UpdateCommand).resolves({});
      await registry().claimFirstAdmin(TENANT, EMAIL);
      const calls = ddb.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.Key).toEqual({ PK: `TENANT#${TENANT}`, SK: 'META' });
      expect(input.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(firstAdminEmail)');
      expect(input.UpdateExpression).toBe('SET firstAdminEmail = :u, updatedAt = :now');
      expect(input.ExpressionAttributeValues[':u']).toBe(EMAIL);
      // The old item rides on the failure so a held slot and a vanished row
      // can be told apart without a read.
      expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
      // No read before the write: the condition decides (control-plane P-5).
      expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('claimFirstAdmin throws ConflictError when the slot is held (the failure carries the row), changing nothing else', async () => {
      const held = Object.assign(conditionFailure(), { Item: { PK: { S: `TENANT#${TENANT}` }, firstAdminEmail: { S: 'other@example.com' } } });
      ddb.on(UpdateCommand).rejects(held);
      await expect(registry().claimFirstAdmin(TENANT, EMAIL)).rejects.toBeInstanceOf(ConflictError);
      await expect(registry().claimFirstAdmin(TENANT, EMAIL)).rejects.toThrow('already has a first admin');
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
      expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it('claimFirstAdmin throws NotFoundError when the row is gone (the failure carries no item): the CreateUser vs DeleteTenant race', async () => {
      ddb.on(UpdateCommand).rejects(conditionFailure());
      await expect(registry().claimFirstAdmin(TENANT, EMAIL)).rejects.toBeInstanceOf(NotFoundError);
      await expect(registry().claimFirstAdmin(TENANT, EMAIL)).rejects.toThrow(`Tenant ${TENANT} not found`);
    });

    it('claimFirstAdmin rethrows any other DynamoDB error', async () => {
      ddb.on(UpdateCommand).rejects(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
      await expect(registry().claimFirstAdmin(TENANT, EMAIL)).rejects.toThrow('throttled');
    });

    it('confirmFirstAdmin is ONE conditional write that accepts an empty slot OR one already held by the same e-mail', async () => {
      ddb.on(UpdateCommand).resolves({});
      await registry().confirmFirstAdmin(TENANT, EMAIL);
      const calls = ddb.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.Key).toEqual({ PK: `TENANT#${TENANT}`, SK: 'META' });
      expect(input.ConditionExpression).toBe('attribute_exists(PK) AND (attribute_not_exists(firstAdminEmail) OR firstAdminEmail = :u)');
      expect(input.UpdateExpression).toBe('SET firstAdminEmail = :u, updatedAt = :now');
      expect(input.ExpressionAttributeValues[':u']).toBe(EMAIL);
      expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
      expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('confirmFirstAdmin throws ConflictError when another e-mail holds the slot, NotFoundError when the row is gone', async () => {
      const held = Object.assign(conditionFailure(), { Item: { PK: { S: `TENANT#${TENANT}` }, firstAdminEmail: { S: 'other@example.com' } } });
      ddb.on(UpdateCommand).rejectsOnce(held).rejectsOnce(conditionFailure());
      await expect(registry().confirmFirstAdmin(TENANT, EMAIL)).rejects.toBeInstanceOf(ConflictError);
      await expect(registry().confirmFirstAdmin(TENANT, EMAIL)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('confirmFirstAdmin rethrows any other DynamoDB error', async () => {
      ddb.on(UpdateCommand).rejects(Object.assign(new Error('down'), { name: 'InternalServerError' }));
      await expect(registry().confirmFirstAdmin(TENANT, EMAIL)).rejects.toThrow('down');
    });

    it('activate writes the first-admin slot in the same conditional update as the status flip when CreateTenant passes it (ADR-0032)', async () => {
      const r = record(TENANT, { status: 'ACTIVE', groupName: `t-${TENANT}`, firstAdminEmail: EMAIL });
      ddb.on(UpdateCommand).resolves({ Attributes: item(r) });
      const got = await registry().activate(TENANT, { groupName: `t-${TENANT}`, firstAdminEmail: EMAIL });
      const calls = ddb.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #s = :provisioning');
      expect(input.UpdateExpression).toContain('#firstAdminEmail = :firstAdminEmail');
      expect(input.ExpressionAttributeValues[':firstAdminEmail']).toBe(EMAIL);
      expect(got.firstAdminEmail).toBe(EMAIL);
      // Without it (a plain activate) the attribute is never touched.
      ddb.reset();
      ddb.on(UpdateCommand).resolves({ Attributes: item(record(TENANT, { status: 'ACTIVE' })) });
      await registry().activate(TENANT, { groupName: `t-${TENANT}` });
      expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.UpdateExpression).not.toContain('firstAdminEmail');
    });

    it('releaseFirstAdmin removes the attribute only when the given name holds it', async () => {
      ddb.on(UpdateCommand).resolves({});
      await registry().releaseFirstAdmin(TENANT, EMAIL);
      const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
      expect(input.Key).toEqual({ PK: `TENANT#${TENANT}`, SK: 'META' });
      expect(input.ConditionExpression).toBe('attribute_exists(PK) AND firstAdminEmail = :u');
      expect(input.UpdateExpression).toBe('REMOVE firstAdminEmail SET updatedAt = :now');
      expect(input.ExpressionAttributeValues[':u']).toBe(EMAIL);
    });

    it('releaseFirstAdmin treats a failed condition (held by another, or already empty) as done', async () => {
      ddb.on(UpdateCommand).rejects(conditionFailure());
      await expect(registry().releaseFirstAdmin(TENANT, EMAIL)).resolves.toBeUndefined();
    });

    it('releaseFirstAdmin rethrows any other DynamoDB error', async () => {
      ddb.on(UpdateCommand).rejects(Object.assign(new Error('down'), { name: 'InternalServerError' }));
      await expect(registry().releaseFirstAdmin(TENANT, EMAIL)).rejects.toThrow('down');
    });

    it('get returns firstAdminEmail from the row (the service decides what leaves through the API)', async () => {
      const r = record(TENANT, { firstAdminEmail: EMAIL });
      ddb.on(GetCommand).resolves({ Item: item(r) });
      expect((await registry().get(TENANT))?.firstAdminEmail).toBe(EMAIL);
    });
  });

  it('never writes an item with user or membership fields (R-10)', async () => {
    const r = record('01ARZ3NDEKTSV4RRFFQ69G5FA8');
    ddb.on(PutCommand).resolves({});
    await registry().create(r);
    const putCalls = ddb.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const written = putCalls[0].args[0].input.Item as Record<string, unknown>;
    for (const forbidden of ['username', 'email', 'password', 'membership', 'accessToken', 'refreshToken', 'sub', 'groups']) {
      expect(written).not.toHaveProperty(forbidden);
    }
  });
});

describe('DynamoDBRegistry batchGet backoff (UnprocessedKeys)', () => {
  const unprocessed = (id: string) => ({ UnprocessedKeys: { [TABLE]: { Keys: [{ PK: `TENANT#${id}`, SK: 'META' }] } } });

  it('sleeps with exponential, jittered, capped backoff between retries, never before the first read', async () => {
    const a = record('01ARZ3NDEKTSV4RRFFQ69G5FA1');
    ddb
      .on(BatchGetCommand)
      .resolvesOnce(unprocessed(a.tenantId))
      .resolvesOnce(unprocessed(a.tenantId))
      .resolvesOnce({ Responses: { [TABLE]: [item(a)] } });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const registry = new DynamoDBRegistry(TABLE, client, undefined, undefined, sleep);
    expect(await registry.batchGet([a.tenantId])).toEqual([a]);
    // Three reads, two waits: before retry 1 and retry 2 only.
    expect(ddb).toHaveReceivedCommandTimes(AnyBatchGet, 3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(sleep.mock.calls[0][0]).toBeLessThan(50); // 25 * 2^1
    expect(sleep.mock.calls[1][0]).toBeLessThan(100); // 25 * 2^2
  });

  it('gives up after six reads, sleeping between each', async () => {
    ddb.on(BatchGetCommand).resolves(unprocessed('01ARZ3NDEKTSV4RRFFQ69G5FA1'));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const registry = new DynamoDBRegistry(TABLE, client, undefined, undefined, sleep);
    await expect(registry.batchGet(['01ARZ3NDEKTSV4RRFFQ69G5FA1'])).rejects.toThrow('Registry batch read did not complete');
    expect(ddb).toHaveReceivedCommandTimes(AnyBatchGet, 6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('backoffDelay is full jitter under min(400, 25 * 2^attempt)', () => {
    expect(backoffDelay(1, () => 0.999)).toBe(49);
    expect(backoffDelay(3, () => 0.5)).toBe(100);
    expect(backoffDelay(10, () => 0.999)).toBe(399);
    expect(backoffDelay(10, () => 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scope catalogue rows and the tenant entitlement (ADR-0034, ADR-0035)
// ---------------------------------------------------------------------------

describe('DynamoDBRegistry scope catalogue (ADR-0034)', () => {
  const now = new Date('2026-10-29T10:00:00.000Z');
  const registry = () => new DynamoDBRegistry(TABLE, client, undefined, () => now);
  const scopeItem = (name: string, extra: Record<string, unknown> = {}) => ({
    PK: 'SCOPE',
    SK: name,
    name,
    owner: name.split('/')[0],
    createdAt: '2026-10-29T09:00:00.000Z',
    ...extra,
  });

  it('putScope is one UpdateItem on PK=SCOPE / SK=<name> that keeps an existing createdAt', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: scopeItem('billing/read', { description: 'Read invoices' }) });
    const written = await registry().putScope({ name: 'billing/read', owner: 'billing', description: 'Read invoices' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'SCOPE', SK: 'billing/read' });
    expect(input.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
    expect(input.UpdateExpression).toContain('#desc = :desc');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':name': 'billing/read', ':owner': 'billing', ':desc': 'Read invoices', ':now': now.toISOString() });
    expect(input.ReturnValues).toBe('ALL_NEW');
    expect(written).toEqual({ name: 'billing/read', owner: 'billing', description: 'Read invoices', createdAt: '2026-10-29T09:00:00.000Z' });
  });

  it('putScope without a description removes a stale one', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: scopeItem('billing/read') });
    await registry().putScope({ name: 'billing/read', owner: 'billing' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE #desc');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':desc');
  });

  it('getScope reads the row consistently and strips the keys; absent is undefined', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: scopeItem('billing/read') }).resolvesOnce({});
    expect(await registry().getScope('billing/read')).toEqual({ name: 'billing/read', owner: 'billing', createdAt: '2026-10-29T09:00:00.000Z' });
    expect(ddb.commandCalls(GetCommand)[0].args[0].input).toMatchObject({ Key: { PK: 'SCOPE', SK: 'billing/read' }, ConsistentRead: true });
    expect(await registry().getScope('billing/none')).toBeUndefined();
  });

  it('listScopes queries PK=SCOPE with an opaque nextToken that names a scope key', async () => {
    ddb.on(QueryCommand).resolvesOnce({ Items: [scopeItem('a/b')], LastEvaluatedKey: { PK: 'SCOPE', SK: 'a/b' } }).resolvesOnce({ Items: [scopeItem('c/d')] });
    const page = await registry().listScopes();
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      KeyConditionExpression: 'PK = :scope',
      ExpressionAttributeValues: { ':scope': 'SCOPE' },
      Limit: 50,
    });
    expect(page.items.map((s) => s.name)).toEqual(['a/b']);
    expect(page.nextToken).toBeDefined();
    const next = await registry().listScopes(page.nextToken);
    expect(ddb.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({ PK: 'SCOPE', SK: 'a/b' });
    expect(next.items.map((s) => s.name)).toEqual(['c/d']);
    expect(next.nextToken).toBeUndefined();
  });

  it('listScopes rejects a tenant-list nextToken, and list rejects a scope-list one (400)', async () => {
    const tenantToken = Buffer.from(JSON.stringify({ PK: 'TENANT#01ARZ3NDEKTSV4RRFFQ69G5FAV', SK: 'META' })).toString('base64url');
    const scopeToken = Buffer.from(JSON.stringify({ PK: 'SCOPE', SK: 'a/b' })).toString('base64url');
    await expect(registry().listScopes(tenantToken)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(registry().list(scopeToken)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('listScopeNames follows every page and returns the sort keys only', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ SK: 'a/b' }, { SK: 'c/d' }], LastEvaluatedKey: { PK: 'SCOPE', SK: 'c/d' } })
      .resolvesOnce({ Items: [{ SK: 'e/f' }] });
    expect(await registry().listScopeNames()).toEqual(['a/b', 'c/d', 'e/f']);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({ ProjectionExpression: 'SK', ConsistentRead: true });
    expect(ddb.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({ PK: 'SCOPE', SK: 'c/d' });
  });

  it('deleteScope is one DeleteItem and a missing row is not an error', async () => {
    ddb.on(DeleteCommand).resolves({});
    await expect(registry().deleteScope('billing/read')).resolves.toBeUndefined();
    expect(ddb.commandCalls(DeleteCommand)[0].args[0].input).toEqual({ TableName: TABLE, Key: { PK: 'SCOPE', SK: 'billing/read' } });
  });

  it('list (tenants) keeps the SK = META filter that excludes scope rows (§4.3, ADR-0034)', async () => {
    ddb.on(ScanCommand).resolves({ Items: [] });
    await registry().list();
    expect(ddb.commandCalls(ScanCommand)[0].args[0].input).toMatchObject({ FilterExpression: 'SK = :meta', ExpressionAttributeValues: { ':meta': 'META' } });
  });
});

describe('DynamoDBRegistry tenant entitlement (ADR-0035)', () => {
  const now = new Date('2026-10-29T10:00:00.000Z');
  const registry = () => new DynamoDBRegistry(TABLE, client, undefined, () => now);
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  it('updateTenantScopes replaces the list on an existing row and returns the row', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: item(record(id, { scopes: ['a/b'] })) });
    const updated = await registry().updateTenantScopes(id, ['a/b']);
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: `TENANT#${id}`, SK: 'META' });
    expect(input.UpdateExpression).toBe('SET scopes = :scopes, updatedAt = :now');
    expect(input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(input.ExpressionAttributeValues).toEqual({ ':scopes': ['a/b'], ':now': now.toISOString() });
    expect(updated.scopes).toEqual(['a/b']);
  });

  it('updateTenantScopes on a vanished row is a NotFoundError and creates no stub', async () => {
    const failure = new Error('cond');
    failure.name = 'ConditionalCheckFailedException';
    ddb.on(UpdateCommand).rejects(failure);
    await expect(registry().updateTenantScopes(id, [])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create writes the scopes on the row and get returns them', async () => {
    const r = record(id, { scopes: ['a/b', 'c/d'] });
    ddb.on(PutCommand).resolves({});
    await registry().create(r);
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ scopes: ['a/b', 'c/d'] });
    ddb.on(GetCommand).resolves({ Item: item(r) });
    expect((await registry().get(id))?.scopes).toEqual(['a/b', 'c/d']);
  });
});
