// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LifecycleStatus, SourceType } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  CellDataModel,
  cellKey,
  CellRecord,
  DELETABLE_CELL_STATUSES,
  deleteCellTransition,
  listCellsByAccountQuery,
  listCellsByApplicationQuery,
  listCellsQuery,
} from '../../src/tenant/cell.data-model';

const dataModel = new CellDataModel();

const record: CellRecord = {
  cellId: '01CELL',
  applicationId: 'app-x',
  accountId: '111111111111',
  status: LifecycleStatus.ACTIVE,
  maxTenants: 5,
  tenantCount: 2,
  source: { type: SourceType.GITHUB, location: 'https://example/repository.git' },
  cellScripts: { create: 'cell/create.sh', update: 'cell/update.sh', delete: 'cell/delete.sh' },
  tenantScripts: { create: 't/create.sh', update: 't/update.sh', delete: 't/delete.sh' },
  lastBuildId: undefined,
  statusReason: undefined,
  createdAt: new Date('2026-09-07T00:00:00.000Z'),
  updatedAt: new Date('2026-09-07T00:00:00.000Z'),
};

describe('cellKey', () => {
  test('builds the composite base-table key', () => {
    expect(cellKey('01CELL')).toEqual({ PK: 'CELL#01CELL', SK: 'META' });
  });
});

describe('CellDataModel.toItem', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key', () => {
    expect(item.PK).toBe('CELL#01CELL');
    expect(item.SK).toBe('META');
  });

  test('stamps GSI-1 attributes: static CELL partition, cell sort (§4)', () => {
    expect(item.GSI1PK).toBe('CELL');
    expect(item.GSI1SK).toBe('CELL#01CELL');
  });

  test('carries GSI-2 attributes partitioned by account for ListCells?accountId= (§4.5, ADR-024)', () => {
    expect(item.GSI2PK).toBe('ACCOUNT#111111111111');
    expect(item.GSI2SK).toBe('CELL#01CELL');
  });

  test('carries GSI-3 attributes partitioned by application for ListCells?applicationId= (§4.7, ADR-032)', () => {
    expect(item.GSI3PK).toBe('APPLICATION#app-x');
    expect(item.GSI3SK).toBe('CELL#01CELL');
  });

  test('carries the immutable accountId and applicationId', () => {
    expect(item.accountId).toBe('111111111111');
    expect(item.applicationId).toBe('app-x');
  });

  test('persists the counters and the stamped definition', () => {
    expect(item.maxTenants).toBe(5);
    expect(item.tenantCount).toBe(2);
    expect(item.source).toEqual(record.source);
    expect(item.cellScripts).toEqual(record.cellScripts);
    expect(item.tenantScripts).toEqual(record.tenantScripts);
    expect(item.createdAt).toBe('2026-09-07T00:00:00.000Z');
  });
});

describe('CellDataModel.fromItem', () => {
  test('round-trips a record through the item representation', () => {
    expect(dataModel.fromItem(dataModel.toItem(record))).toEqual(record);
  });

  test('round-trips optional failure/build fields when present', () => {
    const failed: CellRecord = {
      ...record,
      status: LifecycleStatus.UPDATE_FAILED,
      statusReason: 'cell update build failed',
      lastBuildId: 'arn:aws:codebuild:...:build/y',
    };
    expect(dataModel.fromItem(dataModel.toItem(failed))).toEqual(failed);
  });
});

describe('listCellsQuery', () => {
  test('targets the static CELL partition on GSI-1', () => {
    expect(listCellsQuery()).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'CELL' },
    });
  });
});

describe('deleteCellTransition (ADR-014)', () => {
  const transition = deleteCellTransition('2026-09-07T00:00:00.000Z');

  test('accepts ACTIVE and every *_FAILED status — never in-flight', () => {
    expect(DELETABLE_CELL_STATUSES).toEqual([
      LifecycleStatus.ACTIVE,
      LifecycleStatus.CREATE_FAILED,
      LifecycleStatus.UPDATE_FAILED,
      LifecycleStatus.DELETE_FAILED,
    ]);
    expect(transition.fromAnyOf).toEqual(DELETABLE_CELL_STATUSES);
    expect(transition.to).toBe(LifecycleStatus.DELETING);
  });

  test('ANDs the tenantCount = 0 emptiness guard into the same atomic write', () => {
    expect(transition.extraCondition).toEqual({
      conditionExpression: '#tenantCount = :zero',
      expressionAttributeNames: { '#tenantCount': 'tenantCount' },
      expressionAttributeValues: { ':zero': 0 },
    });
  });
});

describe('listCellsByAccountQuery', () => {
  test('queries the GSI-2 ACCOUNT#<id> partition', () => {
    expect(listCellsByAccountQuery('111111111111')).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: 'ACCOUNT#111111111111' },
    });
  });
});

describe('listCellsByApplicationQuery', () => {
  test('queries the GSI-3 APPLICATION#<id> partition, cells only by sort-key prefix (§4.7)', () => {
    expect(listCellsByApplicationQuery('app-x')).toEqual({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', value: 'APPLICATION#app-x' },
      sortKeyPrefix: 'CELL#',
    });
  });
});
