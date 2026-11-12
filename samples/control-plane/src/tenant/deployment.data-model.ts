// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { APPLICATION_KEY_PREFIX } from './application.data-model';
import { CELL_KEY_PREFIX } from './cell.data-model';
import { ParameterValues } from './parameters';
import { TENANT_KEY_PREFIX } from './tenant.data-model';
import {
  DataModel,
  DynamoDBItem,
  GSI1_INDEX_NAME,
  GSI2_INDEX_NAME,
  GSI3_INDEX_NAME,
} from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, PartitionQuery } from '../shared/repository';
import { LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

/** Sort-key prefix of deployment items under their tenant's partition. */
export const DEPLOYMENT_SORT_KEY_PREFIX = 'DEPLOYMENT';
/** GSI-2 static partition value shared by all deployment items (§4.7). */
export const DEPLOYMENT_GSI2_PARTITION = 'DEPLOYMENT';

/**
 * The deployment domain record (ADR-037): one tenant in one application.
 * Identified by `(tenantId, applicationId)`; owns the placement (`cellId`,
 * the N:1 join to a cell of the application, assigned at creation and never
 * changed), the lifecycle status and the build bookkeeping. Carries no
 * source and no scripts — its deployment is defined by its cell's stamped
 * definition (P-4). `adminEmail` is deliberately absent — it is pass-through
 * onboarding input, never persisted (ADR-004). `parameters` holds the
 * values an operator supplied (ADR-039), never a default; it is kept
 * exactly as read — `undefined` when the attribute is absent (a record
 * written before parameters existed), which is a different read from `{}`
 * for the merge guard (R-33).
 */
export interface DeploymentRecord {
  readonly tenantId: string;
  readonly applicationId: string;
  /** The cell this deployment is placed in — assigned at creation, immutable. */
  readonly cellId: string;
  readonly status: LifecycleStatus;
  readonly parameters?: ParameterValues;
  readonly statusReason?: string;
  readonly lastBuildId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of a {@link DeploymentRecord}. The base key
 * is `TENANT#<tenantId>` / `DEPLOYMENT#<applicationId>`, so a tenant's
 * deployments are one base-table query. Deployment items carry all three GSI
 * key sets (§4.7): GSI-1 partitions them by cell (`ListDeployments?cellId=`),
 * GSI-2's static partition serves the unfiltered listing, GSI-3 partitions
 * them by application (`ListDeployments?applicationId=`).
 */
export interface DeploymentItem extends DynamoDBItem {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly GSI2PK: string;
  readonly GSI2SK: string;
  readonly GSI3PK: string;
  readonly GSI3SK: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly cellId: string;
  readonly status: LifecycleStatus;
  readonly parameters?: ParameterValues;
  readonly statusReason?: string;
  readonly lastBuildId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for a deployment. */
export function deploymentKey(tenantId: string, applicationId: string): ItemKey {
  return {
    PK: KeyBuilder.build(TENANT_KEY_PREFIX, tenantId),
    SK: KeyBuilder.build(DEPLOYMENT_SORT_KEY_PREFIX, applicationId),
  };
}

/** GSI-2 query serving the unfiltered `ListDeployments` (§4.7). */
export function listDeploymentsQuery(): GsiQuery {
  return {
    indexName: GSI2_INDEX_NAME,
    partitionKey: { name: 'GSI2PK', value: DEPLOYMENT_GSI2_PARTITION },
  };
}

/** GSI-1 query serving the `ListDeployments?cellId=` filter (§4.7). */
export function listDeploymentsByCellQuery(cellId: string): GsiQuery {
  return {
    indexName: GSI1_INDEX_NAME,
    partitionKey: { name: 'GSI1PK', value: KeyBuilder.build(CELL_KEY_PREFIX, cellId) },
  };
}

/** GSI-3 query serving the `ListDeployments?applicationId=` filter (§4.7). */
export function listDeploymentsByApplicationQuery(applicationId: string): GsiQuery {
  return {
    indexName: GSI3_INDEX_NAME,
    partitionKey: { name: 'GSI3PK', value: KeyBuilder.build(APPLICATION_KEY_PREFIX, applicationId) },
    sortKeyPrefix: `${DEPLOYMENT_SORT_KEY_PREFIX}#`,
  };
}

/**
 * Base-table query serving the `ListDeployments?tenantId=` filter (§4.7): a
 * tenant's deployments share its partition under the `DEPLOYMENT#` sort-key
 * prefix, so no index is needed.
 */
export function listDeploymentsByTenantQuery(tenantId: string): PartitionQuery {
  return {
    partitionKey: KeyBuilder.build(TENANT_KEY_PREFIX, tenantId),
    sortKeyPrefix: `${DEPLOYMENT_SORT_KEY_PREFIX}#`,
  };
}

/** Converts between {@link DeploymentRecord} and its DynamoDB item. */
export class DeploymentDataModel implements DataModel<DeploymentRecord, DeploymentItem> {
  toItem(record: DeploymentRecord): DeploymentItem {
    const byTenant = KeyBuilder.build(DEPLOYMENT_SORT_KEY_PREFIX, record.tenantId);
    return {
      ...deploymentKey(record.tenantId, record.applicationId),
      GSI1PK: KeyBuilder.build(CELL_KEY_PREFIX, record.cellId),
      GSI1SK: byTenant,
      GSI2PK: DEPLOYMENT_GSI2_PARTITION,
      GSI2SK: `${byTenant}#${record.applicationId}`,
      GSI3PK: KeyBuilder.build(APPLICATION_KEY_PREFIX, record.applicationId),
      GSI3SK: byTenant,
      tenantId: record.tenantId,
      applicationId: record.applicationId,
      cellId: record.cellId,
      status: record.status,
      parameters: record.parameters,
      statusReason: record.statusReason,
      lastBuildId: record.lastBuildId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: DeploymentItem): DeploymentRecord {
    return {
      tenantId: item.tenantId,
      applicationId: item.applicationId,
      cellId: item.cellId,
      status: item.status,
      parameters: item.parameters,
      statusReason: item.statusReason,
      lastBuildId: item.lastBuildId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
