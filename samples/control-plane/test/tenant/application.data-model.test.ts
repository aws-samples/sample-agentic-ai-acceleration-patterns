// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PlacementStrategy, SourceType } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  APPLICATION_EMPTY_CONDITION,
  ApplicationDataModel,
  ApplicationItem,
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
  status: 'ACTIVE',
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

  test('persists its status (§4.1, ADR-045)', () => {
    expect(item.status).toBe('ACTIVE');
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
    parameters: [],
    cellParameters: [],
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

describe('putApplicationUpdate declaration lists (§5.5, ADR-039, ADR-040)', () => {
  const base = {
    applicationId: 'app-x',
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    maxTenants: 3,
    placementStrategy: PlacementStrategy.FILL,
    now: '2026-11-12T00:00:00.000Z',
  };
  const tenantList = [{ name: 'LOG_LEVEL', required: false, default: 'info' }];
  const cellList = [{ name: 'CELL_SIZE', default: 'small' }];

  test('both lists sent: both SET, and the write carries no condition (P-5)', () => {
    const update = putApplicationUpdate({ ...base, parameters: tenantList, cellParameters: [] });
    expect(update.updateExpression).toContain('#parameters = :parameters');
    expect(update.updateExpression).toContain('#cellParameters = :cellParameters');
    expect(update.expressionAttributeValues).toMatchObject({ ':parameters': tenantList, ':cellParameters': [] });
    expect(update.conditionExpression).toBeUndefined();
  });

  test('a kept list is not written; an absent read conditions on attribute_not_exists', () => {
    const update = putApplicationUpdate({ ...base, parameters: tenantList, cellParameters: { read: undefined } });
    expect(update.updateExpression).not.toContain('#cellParameters =');
    expect(update.conditionExpression).toBe('attribute_not_exists(#cellParameters)');
    expect(update.expressionAttributeNames).toMatchObject({ '#cellParameters': 'cellParameters' });
  });

  test('a kept list read as [] conditions on equality with [], not on absence', () => {
    const update = putApplicationUpdate({ ...base, parameters: { read: [] }, cellParameters: cellList });
    expect(update.conditionExpression).toBe('#parameters = :read_parameters');
    expect(update.expressionAttributeValues[':read_parameters']).toEqual([]);
  });

  test('two kept lists condition on both, each exactly as read; never on updatedAt', () => {
    const update = putApplicationUpdate({ ...base, parameters: { read: tenantList }, cellParameters: { read: undefined } });
    expect(update.conditionExpression).toBe('#parameters = :read_parameters AND attribute_not_exists(#cellParameters)');
    expect(update.expressionAttributeValues[':read_parameters']).toBe(tenantList);
    expect(update.conditionExpression).not.toContain('updatedAt');
    expect(update.updateExpression).not.toMatch(/#parameters =|#cellParameters =/);
  });
});

describe('ApplicationDataModel keeps the declaration lists exactly as read', () => {
  test('absent stays absent and [] stays [] (they are different reads)', () => {
    const absent = dataModel.fromItem(dataModel.toItem(record));
    expect(absent.parameters).toBeUndefined();
    const empty = dataModel.fromItem({ ...dataModel.toItem(record), parameters: [], cellParameters: [] });
    expect(empty.parameters).toEqual([]);
    expect(empty.cellParameters).toEqual([]);
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

describe('application record status and staged replace (R-47, R-48, ADR-045)', () => {
  const stored = dataModel.toItem(record);
  const staged = {
    source: { type: SourceType.GITHUB, location: 'https://example/v2.git', sourceVersion: 'a'.repeat(40) },
    cellScripts: { create: 'c2/create.sh', update: 'c2/update.sh', delete: 'c2/delete.sh' },
    tenantScripts: { create: 't2/create.sh', update: 't2/update.sh', delete: 't2/delete.sh' },
    maxTenants: 5,
    placementStrategy: PlacementStrategy.FILL,
  };

  test('an item stored before ADR-045 has no status and reads as ACTIVE', () => {
    const legacy: ApplicationItem = { ...stored, status: undefined };
    expect(dataModel.fromItem(legacy).status).toBe('ACTIVE');
  });

  test('round-trips pending with every list sent, and with every list kept (absent)', () => {
    const withLists = { ...staged, parameters: [], cellParameters: [{ name: 'SIZE', default: 'S' }], hooks: [] };
    for (const pending of [withLists, staged]) {
      const updating: ApplicationRecord = { ...record, status: 'UPDATING', pending };
      const item = dataModel.toItem(updating);
      expect(item.pending).toEqual(pending);
      expect(dataModel.fromItem(item)).toEqual(updating);
    }
    // A kept list stays absent: it is not cleared by the commit (§5.5).
    expect(dataModel.fromItem(dataModel.toItem({ ...record, status: 'UPDATING', pending: staged })).pending)
      .not.toHaveProperty('parameters');
  });

  test('copies only the staged fields out of a stored pending', () => {
    const item = { ...stored, pending: { ...staged, cellCount: 7 } } as unknown as ApplicationItem;
    expect(dataModel.fromItem(item).pending).toEqual(staged);
  });
});
