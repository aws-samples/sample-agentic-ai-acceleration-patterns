// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PlacementStrategy, SourceType } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  APPLICATION_EMPTY_CONDITION,
  ApplicationDataModel,
  applicationKey,
  ApplicationRecord,
  DEFAULT_PLACEMENT_STRATEGY,
  listApplicationsQuery,
  putApplicationUpdate,
} from '../../src/tenant/application.data-model';

const dataModel = new ApplicationDataModel();

const record: ApplicationRecord = {
  applicationId: 'app-x',
  source: { type: SourceType.GITHUB, location: 'https://example/repository.git' },
  cellScripts: { create: 'cell/create.sh', update: 'cell/update.sh', delete: 'cell/delete.sh' },
  tenantScripts: { create: 't/create.sh', update: 't/update.sh', delete: 't/delete.sh' },
  maxTenants: 3,
  placementStrategy: PlacementStrategy.ROUND_ROBIN,
  cellCount: 2,
  createdAt: new Date('2026-11-10T00:00:00.000Z'),
  updatedAt: new Date('2026-11-10T01:00:00.000Z'),
};

describe('applicationKey (ADR-032)', () => {
  test('builds the composite base-table key', () => {
    expect(applicationKey('app-x')).toEqual({ PK: 'APPLICATION#app-x', SK: 'META' });
  });
});

describe('ApplicationDataModel', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key and the static GSI-1 partition (§4.7)', () => {
    expect(item.PK).toBe('APPLICATION#app-x');
    expect(item.SK).toBe('META');
    expect(item.GSI1PK).toBe('APPLICATION');
    expect(item.GSI1SK).toBe('APPLICATION#app-x');
  });

  test('carries GSI-1 attributes only', () => {
    expect(item).not.toHaveProperty('GSI2PK');
    expect(item).not.toHaveProperty('GSI3PK');
  });

  test('persists the definition, the strategy and the counter', () => {
    expect(item.source).toEqual(record.source);
    expect(item.cellScripts).toEqual(record.cellScripts);
    expect(item.tenantScripts).toEqual(record.tenantScripts);
    expect(item.maxTenants).toBe(3);
    expect(item.placementStrategy).toBe('ROUND_ROBIN');
    expect(item.cellCount).toBe(2);
    expect(item.createdAt).toBe('2026-11-10T00:00:00.000Z');
  });

  test('has no status (§4.1)', () => {
    expect(item).not.toHaveProperty('status');
  });

  test('round-trips through fromItem', () => {
    expect(dataModel.fromItem(item)).toEqual(record);
  });

  test('listApplicationsQuery targets the GSI-1 APPLICATION partition', () => {
    expect(listApplicationsQuery()).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'APPLICATION' },
    });
  });

  test('the default placement strategy is FILL (ADR-036)', () => {
    expect(DEFAULT_PLACEMENT_STRATEGY).toBe(PlacementStrategy.FILL);
  });
});

describe('putApplicationUpdate (R-29: create-or-replace that never touches cellCount)', () => {
  const update = putApplicationUpdate({
    applicationId: 'app-x',
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    maxTenants: 3,
    placementStrategy: PlacementStrategy.FILL,
    now: '2026-11-10T00:00:00.000Z',
  });

  test('initialises cellCount and createdAt with if_not_exists only', () => {
    expect(update.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(update.updateExpression).toContain('#createdAt = if_not_exists(#createdAt, :now)');
    expect(update.updateExpression).not.toMatch(/#cellCount = :/);
  });

  test('replaces the definition fields and the strategy, and stamps GSI-1', () => {
    for (const field of [
      '#source = :source',
      '#cellScripts = :cellScripts',
      '#tenantScripts = :tenantScripts',
      '#maxTenants = :maxTenants',
      '#placementStrategy = :placementStrategy',
      '#gsi1pk = :gsi1pk',
      '#gsi1sk = :gsi1sk',
      '#updatedAt = :now',
    ]) {
      expect(update.updateExpression).toContain(field);
    }
    expect(update.expressionAttributeValues).toMatchObject({
      ':zero': 0,
      ':applicationId': 'app-x',
      ':gsi1pk': 'APPLICATION',
      ':gsi1sk': 'APPLICATION#app-x',
      ':maxTenants': 3,
      ':placementStrategy': 'FILL',
      ':source': record.source,
    });
  });
});

describe('APPLICATION_EMPTY_CONDITION (DeleteApplication, ADR-032)', () => {
  test('requires the record to exist with cellCount = 0', () => {
    expect(APPLICATION_EMPTY_CONDITION).toEqual({
      conditionExpression: 'attribute_exists(PK) AND #cellCount = :zero',
      expressionAttributeNames: { '#cellCount': 'cellCount' },
      expressionAttributeValues: { ':zero': 0 },
    });
  });
});
