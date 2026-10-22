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
import { DynamoDBRegistry, type TenantRecord } from '../../src/shared/registry';

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
