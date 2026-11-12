// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DataModel, DynamoDBItem, GSI2_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, WriteCondition } from '../shared/repository';

/** Composite key prefix for tenant items (and the partition of their deployments). */
export const TENANT_KEY_PREFIX = 'TENANT';
/** Fixed sort key — one record per tenant. */
export const TENANT_SORT_KEY = 'META';
/** GSI-2 static partition value shared by all tenant items (§4.7). */
export const TENANT_GSI2_PARTITION = 'TENANT';

/**
 * The tenant domain record (ADR-037): the customer. It carries metadata and
 * `deploymentCount` — the authoritative count of the tenant's deployments,
 * claimed in the placement transaction and released in the deployment-delete
 * transaction, never written by `CreateTenant` or `UpdateTenant`. Everything
 * provisioned for a tenant lives on its deployments; the tenant has no cell,
 * no status and no build state (spec R-7).
 */
export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  /** Atomic counter — authoritative number of deployments (never an index count). */
  readonly deploymentCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of a {@link TenantRecord}. Tenant items carry
 * GSI-2 attributes only: the static `TENANT` partition serves `ListTenants`.
 */
export interface TenantItem extends DynamoDBItem {
  readonly GSI2PK: string;
  readonly GSI2SK: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly deploymentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for a tenant. */
export function tenantKey(tenantId: string): ItemKey {
  return { PK: KeyBuilder.build(TENANT_KEY_PREFIX, tenantId), SK: TENANT_SORT_KEY };
}

/** GSI-2 query serving `ListTenants` (§4.7). */
export function listTenantsQuery(): GsiQuery {
  return {
    indexName: GSI2_INDEX_NAME,
    partitionKey: { name: 'GSI2PK', value: TENANT_GSI2_PARTITION },
  };
}

/** The `CreateTenant` insert guard — no write in the design is unconditional (P-5). */
export const TENANT_NOT_EXISTS_CONDITION: WriteCondition = {
  conditionExpression: 'attribute_not_exists(PK)',
};

/**
 * The `DeleteTenant` emptiness guard — `attribute_exists(PK) AND
 * deploymentCount = 0` — the counterpart of the deployment claim (ADR-037).
 * The service reads first for the 404 and treats a condition failure as the
 * 409.
 */
export const TENANT_EMPTY_CONDITION: WriteCondition = {
  conditionExpression: 'attribute_exists(PK) AND #deploymentCount = :zero',
  expressionAttributeNames: { '#deploymentCount': 'deploymentCount' },
  expressionAttributeValues: { ':zero': 0 },
};

/** Converts between {@link TenantRecord} and its DynamoDB item. */
export class TenantDataModel implements DataModel<TenantRecord, TenantItem> {
  toItem(record: TenantRecord): TenantItem {
    return {
      ...tenantKey(record.tenantId),
      GSI2PK: TENANT_GSI2_PARTITION,
      GSI2SK: KeyBuilder.build(TENANT_KEY_PREFIX, record.tenantId),
      tenantId: record.tenantId,
      name: record.name,
      description: record.description,
      deploymentCount: record.deploymentCount,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: TenantItem): TenantRecord {
    return {
      tenantId: item.tenantId,
      name: item.name,
      description: item.description,
      deploymentCount: item.deploymentCount,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
