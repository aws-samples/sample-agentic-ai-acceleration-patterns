// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StoredCellParameterDeclaration, StoredParameterDeclaration } from './parameters';
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
 * `parameters` and `cellParameters` are the declarations its deployments
 * and cells are validated against and take defaults from (ADR-039,
 * ADR-040); they are not part of the definition and never stamped. Each is
 * kept exactly as read — `undefined` when the attribute is absent, which is
 * a different read from an empty list (§5.5). There is no status:
 * application operations are synchronous and run no build.
 */
export interface ApplicationRecord {
  readonly applicationId: string;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  readonly parameters?: readonly StoredParameterDeclaration[];
  readonly cellParameters?: readonly StoredCellParameterDeclaration[];
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
  readonly parameters?: readonly StoredParameterDeclaration[];
  readonly cellParameters?: readonly StoredCellParameterDeclaration[];
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
 * A declaration list a `PutApplication` did not send: kept on the record,
 * and the write is conditioned on it being exactly as read (§5.5).
 * `read` is `undefined` when the attribute was absent.
 */
export interface KeptDeclarations<T> {
  readonly read: readonly T[] | undefined;
}

/**
 * The `PutApplication` create-or-replace write (spec §5.5, R-29) as ONE
 * `UpdateItem`: the definition fields and the strategy are replaced;
 * `createdAt` and `cellCount` are initialised with `if_not_exists` so a
 * replace never resets the counter. Each declaration list is written only
 * when the request sent it (an empty list included, which clears it).
 *
 * When both lists are sent the write carries no condition: an application
 * has no immutable field to guard, unlike an account's `owner`, so it is
 * correct in every prior state (P-5). A list that is kept conditions the
 * write on that list being exactly as read — `attribute_not_exists` when
 * the attribute was absent, equality when present, `[]` included — so two
 * concurrent puts that each send one list cannot store one name in both.
 * Never conditioned on `updatedAt`, which cell creates and deletes write
 * too.
 */
export function putApplicationUpdate(input: {
  readonly applicationId: string;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  /** Sent tenant parameter declarations, or the kept list as read. */
  readonly parameters: readonly StoredParameterDeclaration[] | KeptDeclarations<StoredParameterDeclaration>;
  /** Sent cell parameter declarations, or the kept list as read. */
  readonly cellParameters: readonly StoredCellParameterDeclaration[] | KeptDeclarations<StoredCellParameterDeclaration>;
  readonly now: string;
}): ItemUpdate {
  const sets: string[] = [];
  const conditions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const declarationList = (
    attribute: 'parameters' | 'cellParameters',
    list: readonly unknown[] | KeptDeclarations<unknown>,
  ) => {
    const name = `#${attribute}`;
    names[name] = attribute;
    if (Array.isArray(list)) {
      sets.push(`${name} = :${attribute}`);
      values[`:${attribute}`] = list;
      return;
    }
    const read = (list as KeptDeclarations<unknown>).read;
    if (read === undefined) {
      conditions.push(`attribute_not_exists(${name})`);
    } else {
      conditions.push(`${name} = :read_${attribute}`);
      values[`:read_${attribute}`] = read;
    }
  };
  declarationList('parameters', input.parameters);
  declarationList('cellParameters', input.cellParameters);
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
      ...sets,
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
      ...names,
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
      ...values,
    },
    ...(conditions.length === 0 ? {} : { conditionExpression: conditions.join(' AND ') }),
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
      parameters: record.parameters,
      cellParameters: record.cellParameters,
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
      // Kept exactly as read: the PutApplication kept-list condition
      // compares the stored attribute with this value (§5.5).
      parameters: item.parameters,
      cellParameters: item.cellParameters,
      cellCount: item.cellCount,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
