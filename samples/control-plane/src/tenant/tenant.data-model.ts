// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StoredLastGlobalHook, readLastGlobalHooks } from './hook.data-model';
import { LastGlobalHookEntry } from './hook.types';
import { readRecordStatus } from './record-event.types';
import { DataModel, DynamoDBItem, GSI2_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, WriteCondition } from '../shared/repository';
import { LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

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
 * provisioned for a tenant lives on its deployments; the tenant has no cell
 * and no build state (spec R-7). Its mutations are asynchronous so that
 * global hooks on tenant events can gate them (ADR-045): `status` (absent on
 * an item stored before ADR-045, read as `ACTIVE`, R-47), `statusReason`,
 * `lastGlobalHooks` (written by the workflow's terminal writes only, R-40),
 * `pending` (the `UpdateTenant` values staged while `UPDATING`, R-48) and
 * `operationId` (the execution of the last accepted operation, R-51).
 */
export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  /** Atomic counter — authoritative number of deployments (never an index count). */
  readonly deploymentCount: number;
  readonly status: LifecycleStatus;
  readonly statusReason?: string;
  readonly lastGlobalHooks?: readonly LastGlobalHookEntry[];
  readonly pending?: TenantPending;
  readonly operationId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The values an `UpdateTenant` staged (R-48): the name and description the
 * commit makes live. An absent `description` is removed by the commit
 * (R-50). Present on the record only while it is `UPDATING`.
 */
export interface TenantPending {
  readonly name: string;
  readonly description?: string;
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
  /** Absent on an item stored before ADR-045; read as `ACTIVE` (R-47). */
  readonly status?: LifecycleStatus;
  readonly statusReason?: string;
  /** Written by the workflow's terminal writes: a list of maps, see `readLastGlobalHooks`. */
  readonly lastGlobalHooks?: readonly StoredLastGlobalHook[];
  readonly pending?: TenantPending;
  readonly operationId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Copies only the fields a tenant stages, so nothing else stored in `pending` reaches the domain. */
function readTenantPending(pending: TenantPending | undefined): TenantPending | undefined {
  if (pending === undefined) {
    return undefined;
  }
  return {
    name: pending.name,
    ...(pending.description === undefined ? {} : { description: pending.description }),
  };
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
      status: record.status,
      statusReason: record.statusReason,
      lastGlobalHooks: record.lastGlobalHooks,
      pending: readTenantPending(record.pending),
      operationId: record.operationId,
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
      status: readRecordStatus(item.status),
      statusReason: item.statusReason,
      lastGlobalHooks: item.lastGlobalHooks === undefined ? undefined : readLastGlobalHooks(item.lastGlobalHooks),
      pending: readTenantPending(item.pending),
      operationId: item.operationId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
