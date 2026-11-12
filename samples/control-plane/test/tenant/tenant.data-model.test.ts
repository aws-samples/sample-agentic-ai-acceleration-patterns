// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  listTenantsQuery,
  TENANT_EMPTY_CONDITION,
  TENANT_NOT_EXISTS_CONDITION,
  TenantDataModel,
  tenantKey,
  TenantRecord,
} from '../../src/tenant/tenant.data-model';

const dataModel = new TenantDataModel();

const record: TenantRecord = {
  tenantId: '01TENANT',
  name: 'acme',
  description: 'a tenant',
  deploymentCount: 2,
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

  test('carries no cell, status, build state, source or scripts (R-7, ADR-037)', () => {
    for (const field of [
      'cellId',
      'status',
      'statusReason',
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
