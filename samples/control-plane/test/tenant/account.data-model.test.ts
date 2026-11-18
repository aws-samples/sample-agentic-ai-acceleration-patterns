// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { expectPlaceholdersMatch } from './expression-placeholders';
import {
  AccountDataModel,
  AccountItem,
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
  status: 'ACTIVE',
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

describe('putAccountUpdate (R-24, R-48: one conditional write per path, never cellCount)', () => {
  const base = {
    accountId: '111111111111',
    owner: 'TENANT' as const,
    maxCells: 1,
    externalId: 'fleet-handshake-7f3a',
    operationId: '111111111111-account-create-1763460000000-0a1b2c3d',
    now: '2026-11-09T00:00:00.000Z',
  };

  test.each(['CREATE', 'RE_PUT', 'REPLACE', 'ROTATE'] as const)(
    '%s uses every placeholder it defines and defines every one it uses',
    (path) => {
      for (const applicationIds of [undefined, ['app-x']]) {
        for (const externalId of [undefined, 'fleet-handshake-7f3a']) {
          expectPlaceholdersMatch(putAccountUpdate({ ...base, path, applicationIds, externalId }));
        }
      }
    },
  );

  test('CREATE inserts the policy fields CREATING with the operationId, cellCount and createdAt through if_not_exists', () => {
    const update = putAccountUpdate({ ...base, path: 'CREATE' });
    expect(update.conditionExpression).toBe('attribute_not_exists(PK)');
    expect(update.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(update.updateExpression).toContain('#createdAt = if_not_exists(#createdAt, :now)');
    expect(update.updateExpression).not.toMatch(/#cellCount = :/);
    expect(update.updateExpression).toContain('#externalId = :externalId');
    expect(update.updateExpression).not.toContain('REMOVE');
    expect(update.expressionAttributeValues).toMatchObject({
      ':status': 'CREATING',
      ':operationId': base.operationId,
      ':owner': 'TENANT',
      ':maxCells': 1,
      ':gsi1pk': 'ACCOUNT',
      ':gsi1sk': 'ACCOUNT#111111111111',
    });
  });

  test('RE_PUT writes the values into the record and back to CREATING on CREATE_FAILED with the same owner', () => {
    const update = putAccountUpdate({ ...base, path: 'RE_PUT', externalId: undefined });
    expect(update.conditionExpression).toBe('#status = :createFailed AND #owner = :owner');
    expect(update.expressionAttributeValues).toMatchObject({ ':status': 'CREATING', ':createFailed': 'CREATE_FAILED' });
    // Shared again and without an id: both removed; the old reason cleared.
    expect(update.updateExpression).toMatch(/ REMOVE #externalId, #applicationIds, #statusReason$/);
  });

  test('REPLACE writes externalId at once, stages maxCells and applicationIds, moves to UPDATING (R-48)', () => {
    const update = putAccountUpdate({ ...base, path: 'REPLACE', maxCells: 4, applicationIds: ['app-x'] });
    expect(update.conditionExpression).toBe(
      '#owner = :owner AND (attribute_not_exists(#status) OR #status IN (:active, :updateFailed))',
    );
    expect(update.updateExpression).toContain('#externalId = :externalId');
    expect(update.updateExpression).toContain('#pending = :pending');
    // The live policy fields are untouched.
    expect(update.updateExpression).not.toContain('#maxCells');
    expect(update.updateExpression).not.toContain('#applicationIds');
    expect(update.updateExpression).not.toContain('#owner =');
    expect(update.expressionAttributeValues[':pending']).toEqual({ maxCells: 4, applicationIds: ['app-x'] });
    expect(update.expressionAttributeValues[':pending']).not.toHaveProperty('externalId');
    expect(update.expressionAttributeValues[':status']).toBe('UPDATING');
  });

  test('REPLACE without applicationIds stages none: the commit makes the account shared', () => {
    const update = putAccountUpdate({ ...base, path: 'REPLACE', maxCells: 4 });
    expect(update.expressionAttributeValues[':pending']).toEqual({ maxCells: 4 });
  });

  test('ROTATE writes externalId and updatedAt only, conditioned on owner, UPDATING and the operationId read (R-48)', () => {
    const update = putAccountUpdate({ ...base, path: 'ROTATE', externalId: 'rotated' });
    expect(update.updateExpression).toBe('SET #updatedAt = :now, #externalId = :externalId');
    expect(update.conditionExpression).toBe('#owner = :owner AND #status = :updating AND #operationId = :readOperationId');
    expect(update.expressionAttributeValues[':readOperationId']).toBe(base.operationId);
  });

  test('a ROTATE that drops a vendor account\'s externalId removes it', () => {
    const update = putAccountUpdate({ ...base, owner: 'VENDOR', path: 'ROTATE', externalId: undefined });
    expect(update.updateExpression).toBe('SET #updatedAt = :now REMOVE #externalId');
  });

  test('every path but the rotation needs an operationId', () => {
    expect(() => putAccountUpdate({ ...base, path: 'REPLACE', operationId: undefined })).toThrow(/operationId/);
  });
});

describe('account record status and staged replace (R-47, R-48, ADR-045)', () => {
  const stored = dataModel.toItem(record);

  test('an item stored before ADR-045 has no status and reads as ACTIVE', () => {
    const legacy: AccountItem = { ...stored, status: undefined };
    expect(dataModel.fromItem(legacy).status).toBe('ACTIVE');
  });

  test('round-trips pending: dedicated, and shared once committed', () => {
    for (const pending of [{ maxCells: 4, applicationIds: ['app-x'] }, { maxCells: 4 }]) {
      const updating: AccountRecord = {
        ...record,
        status: 'UPDATING',
        operationId: '111111111111-account-update-1763460000000-0a1b2c3d',
        pending,
      };
      const item = dataModel.toItem(updating);
      expect(item.pending).toEqual(pending);
      expect(dataModel.fromItem(item)).toEqual(updating);
    }
  });

  test('never writes or reads an externalId in pending (R-48)', () => {
    const smuggled = { maxCells: 4, applicationIds: ['app-x'], externalId: 'leaked-id' };
    const item = dataModel.toItem({ ...record, status: 'UPDATING', pending: smuggled });
    expect(item.pending).toEqual({ maxCells: 4, applicationIds: ['app-x'] });
    expect(item.pending).not.toHaveProperty('externalId');
    const read = dataModel.fromItem({ ...stored, pending: smuggled } as AccountItem);
    expect(read.pending).toEqual({ maxCells: 4, applicationIds: ['app-x'] });
    expect(read.pending).not.toHaveProperty('externalId');
    expect(read.externalId).toBe('fleet-handshake-7f3a');
  });
});
