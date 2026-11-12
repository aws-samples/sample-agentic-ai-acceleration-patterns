// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DataModel, DynamoDBItem, GSI1_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, ItemUpdate, WriteCondition } from '../shared/repository';
import {
  PlacementStrategy,
  ScriptLocations,
  SourceDefinition,
} from '../smithy/source/typescript-ssdk-codegen/src';

/** Composite key prefix for application items. */
export const APPLICATION_KEY_PREFIX = 'APPLICATION';
/** Fixed sort key — one record per application. */
export const APPLICATION_SORT_KEY = 'META';
/** GSI-1 static partition value shared by all application items (§4.7). */
export const APPLICATION_GSI1_PARTITION = 'APPLICATION';
/** The `placementStrategy` a `PutApplication` without one gets (ADR-036). */
export const DEFAULT_PLACEMENT_STRATEGY: PlacementStrategy = PlacementStrategy.FILL;

/**
 * The application domain record (ADR-032): the definition every one of its
 * cells is stamped from (`source`, `cellScripts`, `tenantScripts`,
 * `maxTenants`), the placement strategy that orders accounts for a new cell
 * (ADR-036), and `cellCount` — the authoritative count of the application's
 * cells, claimed in the new-cell placement transaction and released in the
 * cell-delete transaction, never written by `PutApplication` (spec R-29).
 * There is no status: application operations are synchronous and run no
 * build.
 */
export interface ApplicationRecord {
  readonly applicationId: string;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  readonly cellCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of an {@link ApplicationRecord}. Application
 * items carry GSI-1 attributes only (static `APPLICATION` partition for
 * `ListApplications`).
 */
export interface ApplicationItem extends DynamoDBItem {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly applicationId: string;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  readonly cellCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for an application. */
export function applicationKey(applicationId: string): ItemKey {
  return { PK: KeyBuilder.build(APPLICATION_KEY_PREFIX, applicationId), SK: APPLICATION_SORT_KEY };
}

/** GSI-1 query serving `ListApplications` (§4.7). */
export function listApplicationsQuery(): GsiQuery {
  return {
    indexName: GSI1_INDEX_NAME,
    partitionKey: { name: 'GSI1PK', value: APPLICATION_GSI1_PARTITION },
  };
}

/**
 * The `PutApplication` create-or-replace write (spec §5.5, R-29) as ONE
 * `UpdateItem`: the definition fields and the strategy are replaced;
 * `createdAt` and `cellCount` are initialised with `if_not_exists` so a
 * replace never resets the counter. There is no immutable field to guard,
 * unlike an account's `owner`, so the write carries no condition — it is
 * correct in every prior state (P-5).
 */
export function putApplicationUpdate(input: {
  readonly applicationId: string;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  readonly now: string;
}): ItemUpdate {
  return {
    updateExpression: [
      'SET #cellCount = if_not_exists(#cellCount, :zero)',
      '#createdAt = if_not_exists(#createdAt, :now)',
      '#applicationId = :applicationId',
      '#gsi1pk = :gsi1pk',
      '#gsi1sk = :gsi1sk',
      '#source = :source',
      '#cellScripts = :cellScripts',
      '#tenantScripts = :tenantScripts',
      '#maxTenants = :maxTenants',
      '#placementStrategy = :placementStrategy',
      '#updatedAt = :now',
    ].join(', '),
    expressionAttributeNames: {
      '#cellCount': 'cellCount',
      '#createdAt': 'createdAt',
      '#applicationId': 'applicationId',
      '#gsi1pk': 'GSI1PK',
      '#gsi1sk': 'GSI1SK',
      '#source': 'source',
      '#cellScripts': 'cellScripts',
      '#tenantScripts': 'tenantScripts',
      '#maxTenants': 'maxTenants',
      '#placementStrategy': 'placementStrategy',
      '#updatedAt': 'updatedAt',
    },
    expressionAttributeValues: {
      ':zero': 0,
      ':now': input.now,
      ':applicationId': input.applicationId,
      ':gsi1pk': APPLICATION_GSI1_PARTITION,
      ':gsi1sk': KeyBuilder.build(APPLICATION_KEY_PREFIX, input.applicationId),
      ':source': input.source,
      ':cellScripts': input.cellScripts,
      ':tenantScripts': input.tenantScripts,
      ':maxTenants': input.maxTenants,
      ':placementStrategy': input.placementStrategy,
    },
  };
}

/**
 * The `DeleteApplication` emptiness guard — `attribute_exists(PK) AND
 * cellCount = 0` — the counterpart of the application's cell-count claim
 * (ADR-032). The service reads first for the 404 and treats a condition
 * failure as the 409.
 */
export const APPLICATION_EMPTY_CONDITION: WriteCondition = {
  conditionExpression: 'attribute_exists(PK) AND #cellCount = :zero',
  expressionAttributeNames: { '#cellCount': 'cellCount' },
  expressionAttributeValues: { ':zero': 0 },
};

/** Converts between {@link ApplicationRecord} and its DynamoDB item. */
export class ApplicationDataModel implements DataModel<ApplicationRecord, ApplicationItem> {
  toItem(record: ApplicationRecord): ApplicationItem {
    return {
      ...applicationKey(record.applicationId),
      GSI1PK: APPLICATION_GSI1_PARTITION,
      GSI1SK: KeyBuilder.build(APPLICATION_KEY_PREFIX, record.applicationId),
      applicationId: record.applicationId,
      source: record.source,
      cellScripts: record.cellScripts,
      tenantScripts: record.tenantScripts,
      maxTenants: record.maxTenants,
      placementStrategy: record.placementStrategy,
      cellCount: record.cellCount,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: ApplicationItem): ApplicationRecord {
    return {
      applicationId: item.applicationId,
      source: item.source,
      cellScripts: item.cellScripts,
      tenantScripts: item.tenantScripts,
      maxTenants: item.maxTenants,
      placementStrategy: item.placementStrategy,
      cellCount: item.cellCount,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
