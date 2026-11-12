// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ACCOUNT_EMPTY_CONDITION,
  AccountDataModel,
  AccountRecord,
  accountKey,
  listAccountsQuery,
  putAccountUpdate,
} from '../../src/tenant/account.data-model';

const dataModel = new AccountDataModel();

const record: AccountRecord = {
  accountId: '111111111111',
  owner: 'VENDOR',
  maxCells: 2,
  cellCount: 1,
  externalId: 'fleet-handshake-7f3a',
  createdAt: new Date('2026-11-09T00:00:00.000Z'),
  updatedAt: new Date('2026-11-09T01:00:00.000Z'),
};

describe('accountKey', () => {
  test('builds the composite base-table key', () => {
    expect(accountKey('111111111111')).toEqual({ PK: 'ACCOUNT#111111111111', SK: 'META' });
  });
});

describe('AccountDataModel', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key and the static GSI-1 partition (§4.5)', () => {
    expect(item.PK).toBe('ACCOUNT#111111111111');
    expect(item.SK).toBe('META');
    expect(item.GSI1PK).toBe('ACCOUNT');
    expect(item.GSI1SK).toBe('ACCOUNT#111111111111');
  });

  test('carries no GSI-2 or GSI-3 attributes — accounts appear only in GSI-1', () => {
    expect(item).not.toHaveProperty('GSI2PK');
    expect(item).not.toHaveProperty('GSI2SK');
    expect(item).not.toHaveProperty('GSI3PK');
  });

  test('round-trips a shared account (no applicationIds) through fromItem', () => {
    expect(item.applicationIds).toBeUndefined();
    expect(dataModel.fromItem(item)).toEqual(record);
  });

  test('round-trips a dedicated account with its applicationIds (ADR-033)', () => {
    const dedicated: AccountRecord = { ...record, applicationIds: ['app-x', 'app-y'] };
    const dedicatedItem = dataModel.toItem(dedicated);
    expect(dedicatedItem.applicationIds).toEqual(['app-x', 'app-y']);
    expect(dataModel.fromItem(dedicatedItem)).toEqual(dedicated);
  });

  test('listAccountsQuery targets the GSI-1 ACCOUNT partition', () => {
    expect(listAccountsQuery()).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'ACCOUNT' },
    });
  });
});

describe('putAccountUpdate (R-24: create-or-replace that never touches cellCount)', () => {
  const update = putAccountUpdate({
    accountId: '111111111111',
    owner: 'TENANT',
    maxCells: 1,
    externalId: 'fleet-handshake-7f3a',
    now: '2026-11-09T00:00:00.000Z',
  });

  test('initialises owner, cellCount, and createdAt with if_not_exists only', () => {
    expect(update.updateExpression).toContain('#owner = if_not_exists(#owner, :owner)');
    expect(update.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(update.updateExpression).toContain('#createdAt = if_not_exists(#createdAt, :now)');
    // The counter is never SET outright: the two transactional paths own it.
    expect(update.updateExpression).not.toMatch(/#cellCount = :/);
  });

  test('replaces the policy fields and stamps the GSI-1 attributes', () => {
    expect(update.updateExpression).toContain('#maxCells = :maxCells');
    expect(update.updateExpression).toContain('#externalId = :externalId');
    expect(update.updateExpression).toContain('#gsi1pk = :gsi1pk');
    expect(update.expressionAttributeValues).toMatchObject({
      ':owner': 'TENANT',
      ':maxCells': 1,
      ':zero': 0,
      ':externalId': 'fleet-handshake-7f3a',
      ':gsi1pk': 'ACCOUNT',
      ':gsi1sk': 'ACCOUNT#111111111111',
    });
  });

  test('the condition makes an owner change fail (immutable owner)', () => {
    expect(update.conditionExpression).toBe('attribute_not_exists(PK) OR #owner = :owner');
  });

  test('omitting externalId removes a previously stored one', () => {
    const noExternalId = putAccountUpdate({
      accountId: '111111111111',
      owner: 'VENDOR',
      maxCells: 3,
      now: '2026-11-09T00:00:00.000Z',
    });
    expect(noExternalId.updateExpression).toMatch(/ REMOVE #externalId, #applicationIds$/);
    expect(noExternalId.expressionAttributeValues).not.toHaveProperty(':externalId');
  });

  test('omitting applicationIds removes the allowlist — the account becomes shared (ADR-033)', () => {
    expect(update.updateExpression).toMatch(/ REMOVE #applicationIds$/);
    expect(update.updateExpression).not.toContain('#applicationIds = :applicationIds');
    expect(update.expressionAttributeValues).not.toHaveProperty(':applicationIds');
  });

  test('a given applicationIds is SET as a list copy — the account becomes dedicated (ADR-033)', () => {
    const ids = ['app-x'];
    const dedicated = putAccountUpdate({
      accountId: '111111111111',
      owner: 'VENDOR',
      maxCells: 2,
      applicationIds: ids,
      externalId: 'fleet-handshake-7f3a',
      now: '2026-11-09T00:00:00.000Z',
    });
    expect(dedicated.updateExpression).toContain('#applicationIds = :applicationIds');
    expect(dedicated.updateExpression).not.toContain('REMOVE');
    expect(dedicated.expressionAttributeNames).toMatchObject({ '#applicationIds': 'applicationIds' });
    expect(dedicated.expressionAttributeValues[':applicationIds']).toEqual(['app-x']);
    expect(dedicated.expressionAttributeValues[':applicationIds']).not.toBe(ids);
  });
});

describe('ACCOUNT_EMPTY_CONDITION (DeleteAccount, ADR-024)', () => {
  test('requires the record to exist with cellCount = 0', () => {
    expect(ACCOUNT_EMPTY_CONDITION.conditionExpression).toBe('attribute_exists(PK) AND #cellCount = :zero');
    expect(ACCOUNT_EMPTY_CONDITION.expressionAttributeValues).toEqual({ ':zero': 0 });
  });
});
