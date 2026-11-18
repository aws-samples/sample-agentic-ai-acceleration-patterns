// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { expectPlaceholdersMatch } from './expression-placeholders';
import { PlacementStrategy, SourceType } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
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

describe('putApplicationUpdate (R-29, R-48: one conditional write per path, never cellCount)', () => {
  const values = {
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    maxTenants: 3,
    placementStrategy: PlacementStrategy.FILL,
  };
  const base = {
    applicationId: 'app-x',
    operationId: 'app-x-application-create-1763460000000-0a1b2c3d',
    values,
    now: '2026-11-10T00:00:00.000Z',
  };
  const tenantList = [{ name: 'LOG_LEVEL', required: false, default: 'info' }];
  const cellList = [{ name: 'CELL_SIZE', default: 'small' }];

  test.each(['CREATE', 'RE_PUT', 'REPLACE'] as const)('%s uses every placeholder it defines and defines every one it uses', (path) => {
    for (const read of [undefined, { parameters: tenantList, cellParameters: [] }]) {
      expectPlaceholdersMatch(putApplicationUpdate({ ...base, path, read }));
      expectPlaceholdersMatch(putApplicationUpdate({ ...base, path, read, values: { ...values, parameters: [], hooks: [] } }));
    }
  });

  test('CREATE inserts the definition CREATING with the operationId, cellCount and createdAt through if_not_exists', () => {
    const update = putApplicationUpdate({ ...base, path: 'CREATE' });
    expect(update.conditionExpression).toBe('attribute_not_exists(PK)');
    expect(update.updateExpression).toContain('#cellCount = if_not_exists(#cellCount, :zero)');
    expect(update.updateExpression).toContain('#createdAt = if_not_exists(#createdAt, :now)');
    expect(update.updateExpression).not.toMatch(/#cellCount = :/);
    for (const field of ['#source = :source', '#cellScripts = :cellScripts', '#tenantScripts = :tenantScripts',
      '#maxTenants = :maxTenants', '#placementStrategy = :placementStrategy', '#gsi1pk = :gsi1pk', '#gsi1sk = :gsi1sk']) {
      expect(update.updateExpression).toContain(field);
    }
    expect(update.expressionAttributeValues).toMatchObject({
      ':status': 'CREATING',
      ':operationId': base.operationId,
      ':gsi1pk': 'APPLICATION',
      ':gsi1sk': 'APPLICATION#app-x',
      ':maxTenants': 3,
    });
    // A new application declares no list it was not sent.
    expect(update.updateExpression).not.toMatch(/#parameters|#cellParameters|#hooks/);
  });

  test('RE_PUT writes the values into the record and back to CREATING, conditioned on CREATE_FAILED and the kept lists', () => {
    const update = putApplicationUpdate({
      ...base,
      path: 'RE_PUT',
      values: { ...values, cellParameters: cellList },
      read: { parameters: tenantList, cellParameters: undefined },
    });
    expect(update.conditionExpression).toBe('#status = :createFailed AND #parameters = :read_parameters');
    expect(update.updateExpression).toContain('#cellParameters = :cellParameters');
    expect(update.updateExpression).toMatch(/ REMOVE #statusReason$/);
    expect(update.expressionAttributeValues[':status']).toBe('CREATING');
  });

  test('REPLACE stages the values in pending and moves to UPDATING; the live definition is untouched', () => {
    const staged = { ...values, parameters: tenantList };
    const update = putApplicationUpdate({ ...base, path: 'REPLACE', values: staged, read: { parameters: [], cellParameters: [] } });
    expect(update.conditionExpression).toBe(
      '(attribute_not_exists(#status) OR #status IN (:active, :updateFailed)) AND #cellParameters = :read_cellParameters',
    );
    expect(update.expressionAttributeValues[':pending']).toBe(staged);
    expect(update.expressionAttributeValues[':read_cellParameters']).toEqual([]);
    expect(update.expressionAttributeValues[':status']).toBe('UPDATING');
    expect(update.updateExpression).not.toMatch(/#source|#cellScripts|#maxTenants|#parameters =|#hooks/);
  });

  test('a kept list read as absent conditions on attribute_not_exists, one read as [] on equality with []', () => {
    const absent = putApplicationUpdate({ ...base, path: 'REPLACE', values: { ...values, cellParameters: [] }, read: {} });
    expect(absent.conditionExpression).toContain('attribute_not_exists(#parameters)');
    const empty = putApplicationUpdate({ ...base, path: 'REPLACE', values: { ...values, cellParameters: [] }, read: { parameters: [] } });
    expect(empty.conditionExpression).toContain('#parameters = :read_parameters');
    expect(empty.expressionAttributeValues[':read_parameters']).toEqual([]);
  });

  test('a kept hooks list adds no condition, and nothing is conditioned on updatedAt', () => {
    const update = putApplicationUpdate({ ...base, path: 'REPLACE', values: { ...values, parameters: [], cellParameters: [] }, read: {} });
    expect(update.conditionExpression).toBe('(attribute_not_exists(#status) OR #status IN (:active, :updateFailed))');
    expect(update.conditionExpression).not.toContain('updatedAt');
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
