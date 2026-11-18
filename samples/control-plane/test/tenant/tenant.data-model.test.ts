// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  listTenantsQuery,
  TENANT_EMPTY_CONDITION,
  TENANT_NOT_EXISTS_CONDITION,
  TenantDataModel,
  TenantItem,
  tenantKey,
  TenantRecord,
} from '../../src/tenant/tenant.data-model';

const dataModel = new TenantDataModel();

const record: TenantRecord = {
  tenantId: '01TENANT',
  name: 'acme',
  description: 'a tenant',
  deploymentCount: 2,
  status: 'ACTIVE',
  createdAt: new Date('2026-09-07T00:00:00.000Z'),
  updatedAt: new Date('2026-09-07T00:00:00.000Z'),
};

describe('tenantKey', () => {
  test('builds the composite base-table key', () => {
    expect(tenantKey('01TENANT')).toEqual({ PK: 'TENANT#01TENANT', SK: 'META' });
  });
});

describe('TenantDataModel.toItem', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key', () => {
    expect(item.PK).toBe('TENANT#01TENANT');
    expect(item.SK).toBe('META');
  });

  test('stamps GSI-2 attributes only: static TENANT partition (§4.7)', () => {
    expect(item.GSI2PK).toBe('TENANT');
    expect(item.GSI2SK).toBe('TENANT#01TENANT');
    expect(item).not.toHaveProperty('GSI1PK');
    expect(item).not.toHaveProperty('GSI3PK');
  });

  test('persists deploymentCount and serialises dates to ISO strings', () => {
    expect(item.deploymentCount).toBe(2);
    expect(item.createdAt).toBe('2026-09-07T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-09-07T00:00:00.000Z');
  });

  test('carries no cell, build state, source or scripts (R-7, ADR-037)', () => {
    for (const field of [
      'cellId',
      'lastBuildId',
      'source',
      'cellScripts',
      'tenantScripts',
      'adminEmail',
    ]) {
      expect(item).not.toHaveProperty(field);
    }
  });
});

describe('TenantDataModel.fromItem', () => {
  test('round-trips a record through the item representation', () => {
    expect(dataModel.fromItem(dataModel.toItem(record))).toEqual(record);
  });

  test('round-trips a record without a description', () => {
    const bare: TenantRecord = { ...record, description: undefined };
    expect(dataModel.fromItem(dataModel.toItem(bare))).toEqual(bare);
  });
});

describe('tenant list query', () => {
  test('listTenantsQuery targets the sparse GSI-2 static partition', () => {
    expect(listTenantsQuery()).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: 'TENANT' },
    });
  });
});

describe('tenant write conditions (P-5, §5.1)', () => {
  test('CreateTenant inserts only when the record does not exist', () => {
    expect(TENANT_NOT_EXISTS_CONDITION).toEqual({ conditionExpression: 'attribute_not_exists(PK)' });
  });

  test('DeleteTenant deletes only an existing tenant with no deployments', () => {
    expect(TENANT_EMPTY_CONDITION).toEqual({
      conditionExpression: 'attribute_exists(PK) AND #deploymentCount = :zero',
      expressionAttributeNames: { '#deploymentCount': 'deploymentCount' },
      expressionAttributeValues: { ':zero': 0 },
    });
  });
});

describe('tenant record status and staged update (R-47, R-48, ADR-045)', () => {
  const stored = dataModel.toItem(record);

  test('an item stored before ADR-045 has no status and reads as ACTIVE', () => {
    const legacy: TenantItem = { ...stored, status: undefined };
    expect(dataModel.fromItem(legacy).status).toBe('ACTIVE');
  });

  test('persists the status, reason, operation id and last global hooks', () => {
    const failed: TenantRecord = {
      ...record,
      status: 'UPDATE_FAILED',
      statusReason: 'PRE hook gate failed',
      operationId: '01TENANT-tenant-update-1763460000000-0a1b2c3d',
      lastGlobalHooks: [{ hookId: 'gate', phase: 'PRE', revision: 2, sourceVersion: 'main', resolvedSourceVersion: 'a'.repeat(40) }],
    };
    const item = dataModel.toItem(failed);
    expect(item.status).toBe('UPDATE_FAILED');
    expect(item.operationId).toBe('01TENANT-tenant-update-1763460000000-0a1b2c3d');
    expect(dataModel.fromItem(item)).toEqual(failed);
  });

  test('round-trips pending, with and without a description', () => {
    for (const pending of [{ name: 'acme-renamed', description: 'new' }, { name: 'acme-renamed' }]) {
      const updating: TenantRecord = { ...record, status: 'UPDATING', pending };
      const item = dataModel.toItem(updating);
      expect(item.pending).toEqual(pending);
      expect(dataModel.fromItem(item).pending).toEqual(pending);
    }
  });

  test('copies only name and description out of a stored pending', () => {
    const item = { ...stored, pending: { name: 'x', description: 'y', deploymentCount: 9 } } as unknown as TenantItem;
    expect(dataModel.fromItem(item).pending).toEqual({ name: 'x', description: 'y' });
  });
});
