// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LifecycleStatus } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  DeploymentDataModel,
  deploymentKey,
  DeploymentRecord,
  listDeploymentsByApplicationQuery,
  listDeploymentsByCellQuery,
  listDeploymentsByTenantQuery,
  listDeploymentsQuery,
} from '../../src/tenant/deployment.data-model';

const dataModel = new DeploymentDataModel();

const record: DeploymentRecord = {
  tenantId: '01TENANT',
  applicationId: 'app-x',
  cellId: '01CELL',
  status: LifecycleStatus.CREATING,
  statusReason: undefined,
  lastBuildId: undefined,
  createdAt: new Date('2026-11-11T00:00:00.000Z'),
  updatedAt: new Date('2026-11-11T00:00:00.000Z'),
};

describe('deploymentKey (ADR-037)', () => {
  test('lives under the tenant partition, one sort key per application', () => {
    expect(deploymentKey('01TENANT', 'app-x')).toEqual({
      PK: 'TENANT#01TENANT',
      SK: 'DEPLOYMENT#app-x',
    });
  });
});

describe('DeploymentDataModel.toItem', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key', () => {
    expect(item.PK).toBe('TENANT#01TENANT');
    expect(item.SK).toBe('DEPLOYMENT#app-x');
  });

  test('stamps GSI-1 by cell for ListDeployments?cellId= (§4.7)', () => {
    expect(item.GSI1PK).toBe('CELL#01CELL');
    expect(item.GSI1SK).toBe('DEPLOYMENT#01TENANT');
  });

  test('stamps the static GSI-2 DEPLOYMENT partition for the unfiltered listing (§4.7)', () => {
    expect(item.GSI2PK).toBe('DEPLOYMENT');
    expect(item.GSI2SK).toBe('DEPLOYMENT#01TENANT#app-x');
  });

  test('stamps GSI-3 by application for ListDeployments?applicationId= (§4.7)', () => {
    expect(item.GSI3PK).toBe('APPLICATION#app-x');
    expect(item.GSI3SK).toBe('DEPLOYMENT#01TENANT');
  });

  test('carries no source, scripts or adminEmail — the cell owns the definition (R-31, R-8)', () => {
    expect(item).not.toHaveProperty('source');
    expect(item).not.toHaveProperty('cellScripts');
    expect(item).not.toHaveProperty('tenantScripts');
    expect(item).not.toHaveProperty('adminEmail');
  });

  test('serialises dates to ISO strings', () => {
    expect(item.createdAt).toBe('2026-11-11T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-11-11T00:00:00.000Z');
  });
});

describe('DeploymentDataModel.fromItem', () => {
  test('round-trips a record through the item representation', () => {
    expect(dataModel.fromItem(dataModel.toItem(record))).toEqual(record);
  });

  test('round-trips optional failure/build fields when present', () => {
    const failed: DeploymentRecord = {
      ...record,
      status: LifecycleStatus.CREATE_FAILED,
      statusReason: 'build failed',
      lastBuildId: 'arn:aws:codebuild:...:build/x',
    };
    expect(dataModel.fromItem(dataModel.toItem(failed))).toEqual(failed);
  });
});

describe('deployment list queries (§4.7, R-10: every query pinned to a partition)', () => {
  test('unfiltered: the GSI-2 static DEPLOYMENT partition', () => {
    expect(listDeploymentsQuery()).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: 'DEPLOYMENT' },
    });
  });

  test('by cell: the GSI-1 CELL#<id> partition', () => {
    expect(listDeploymentsByCellQuery('01CELL')).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'CELL#01CELL' },
    });
  });

  test('by application: the GSI-3 APPLICATION#<id> partition, deployments only by prefix', () => {
    expect(listDeploymentsByApplicationQuery('app-x')).toEqual({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', value: 'APPLICATION#app-x' },
      sortKeyPrefix: 'DEPLOYMENT#',
    });
  });

  test('by tenant: the base-table TENANT#<id> partition under the DEPLOYMENT# prefix', () => {
    expect(listDeploymentsByTenantQuery('01TENANT')).toEqual({
      partitionKey: 'TENANT#01TENANT',
      sortKeyPrefix: 'DEPLOYMENT#',
    });
  });
});
