// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { StoredLastGlobalHook, readLastGlobalHooks } from './hook.data-model';
import { HookDefinition, LastGlobalHookEntry } from './hook.types';
import { StoredCellParameterDeclaration, StoredParameterDeclaration } from './parameters';
import { readRecordStatus } from './record-event.types';
import { operationIdAsRead } from './record-writes';
import { DataModel, DynamoDBItem, GSI1_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, ItemUpdate } from '../shared/repository';
import {
  LifecycleStatus,
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
 * a different read from an empty list (§5.5). `hooks` are the application
 * hooks (ADR-044), part of the definition and stamped onto each new cell;
 * replaced only when a request sends them. Application mutations are
 * asynchronous so that hooks on application events can gate them
 * (ADR-045): `status` (absent on an item stored before ADR-045, read as
 * `ACTIVE`, R-47), `statusReason`, `lastGlobalHooks` (terminal writes only,
 * R-40), `pending` (the values a replace staged while `UPDATING`, R-48) and
 * `operationId` (R-51). Placement, parameter validation and stamping read
 * the live fields, never `pending` (R-47).
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
  readonly hooks?: readonly HookDefinition[];
  readonly cellCount: number;
  readonly status: LifecycleStatus;
  readonly statusReason?: string;
  readonly lastGlobalHooks?: readonly LastGlobalHookEntry[];
  readonly pending?: ApplicationPending;
  readonly operationId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The values a replacing `PutApplication` staged (R-29, R-48): the
 * definition fields other than `hooks` and the strategy, always; each of
 * `parameters`, `cellParameters` and `hooks` only when the request sent it.
 * The commit copies each field present and keeps an absent list (R-50).
 * Present only while `UPDATING`.
 */
export interface ApplicationPending {
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
  readonly placementStrategy: PlacementStrategy;
  readonly parameters?: readonly StoredParameterDeclaration[];
  readonly cellParameters?: readonly StoredCellParameterDeclaration[];
  readonly hooks?: readonly HookDefinition[];
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
  readonly hooks?: readonly HookDefinition[];
  readonly cellCount: number;
  /** Absent on an item stored before ADR-045; read as `ACTIVE` (R-47). */
  readonly status?: LifecycleStatus;
  readonly statusReason?: string;
  /** Written by the workflow's terminal writes: a list of maps, see `readLastGlobalHooks`. */
  readonly lastGlobalHooks?: readonly StoredLastGlobalHook[];
  readonly pending?: ApplicationPending;
  readonly operationId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Copies only the fields an application stages, keeping an absent list absent (kept, not cleared). */
function readApplicationPending(pending: ApplicationPending | undefined): ApplicationPending | undefined {
  if (pending === undefined) {
    return undefined;
  }
  return {
    source: pending.source,
    cellScripts: pending.cellScripts,
    tenantScripts: pending.tenantScripts,
    maxTenants: pending.maxTenants,
    placementStrategy: pending.placementStrategy,
    ...(pending.parameters === undefined ? {} : { parameters: pending.parameters }),
    ...(pending.cellParameters === undefined ? {} : { cellParameters: pending.cellParameters }),
    ...(pending.hooks === undefined ? {} : { hooks: pending.hooks }),
  };
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
 * The path a `PutApplication` takes, chosen from a strongly consistent
 * read (R-48, §5.5): `CREATE` for an id with no record, `RE_PUT` for a
 * `CREATE_FAILED` record, `REPLACE` for a live one.
 */
export type PutApplicationPath = 'CREATE' | 'RE_PUT' | 'REPLACE';

/**
 * The `PutApplication` write (spec §5.5, R-29, R-48) as ONE conditional
 * `UpdateItem` on every path. `values` holds the definition fields, the
 * strategy and each of `parameters`, `cellParameters` and `hooks` only when
 * the request sent it (an empty list included, which clears it).
 *
 * - `CREATE`: the values into the record, `CREATING`, conditional on
 *   `attribute_not_exists(PK)`.
 * - `RE_PUT`: the values into the record and back to `CREATING`,
 *   conditional on `status = CREATE_FAILED`.
 * - `REPLACE`: the values into `pending` and the record to `UPDATING`,
 *   conditional on `ACTIVE`/`UPDATE_FAILED` (or an absent status, R-47);
 *   the live definition unchanged until the workflow commits (R-50).
 *
 * Each stores `operationId` (R-51) and sets `cellCount` and `createdAt`
 * through `if_not_exists`, so a re-put never resets them, and clears a
 * stale `statusReason`. On `RE_PUT` and `REPLACE` a declaration list the
 * request keeps conditions the write on that list being exactly as `read`
 * — `attribute_not_exists` when the attribute was absent, equality when
 * present, `[]` included — so two concurrent puts that each send one list
 * cannot store one name in both. A kept `hooks` list adds no condition of
 * its own: hooks share no invariant with another list. `RE_PUT` and
 * `REPLACE` are also conditioned on the `operationId` as read
 * (`operationIdAsRead`, R-48): the event's application hooks come from the
 * read record when the request keeps them (R-40), so a put another request
 * accepted since the read must refuse this one rather than let it run a
 * hook list that put replaced. Never conditioned on `updatedAt`, which cell
 * creates and deletes write too.
 */
export function putApplicationUpdate(input: {
  readonly path: PutApplicationPath;
  readonly applicationId: string;
  readonly operationId: string;
  readonly values: ApplicationPending;
  /** The record the path was chosen from; its lists are the kept lists' read values, its `operationId` the one read. */
  readonly read?: Pick<ApplicationRecord, 'parameters' | 'cellParameters' | 'operationId'>;
  readonly now: string;
}): ItemUpdate {
  const { path, values } = input;
  const names: Record<string, string> = {
    '#cellCount': 'cellCount',
    '#createdAt': 'createdAt',
    '#applicationId': 'applicationId',
    '#gsi1pk': 'GSI1PK',
    '#gsi1sk': 'GSI1SK',
    '#status': 'status',
    '#operationId': 'operationId',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, unknown> = {
    ':zero': 0,
    ':now': input.now,
    ':applicationId': input.applicationId,
    ':gsi1pk': APPLICATION_GSI1_PARTITION,
    ':gsi1sk': KeyBuilder.build(APPLICATION_KEY_PREFIX, input.applicationId),
    ':operationId': input.operationId,
  };
  const sets = [
    '#cellCount = if_not_exists(#cellCount, :zero)',
    '#createdAt = if_not_exists(#createdAt, :now)',
    '#applicationId = :applicationId',
    '#gsi1pk = :gsi1pk',
    '#gsi1sk = :gsi1sk',
    '#status = :status',
    '#operationId = :operationId',
    '#updatedAt = :now',
  ];
  const conditions: string[] = [];

  if (path === 'REPLACE') {
    names['#pending'] = 'pending';
    sets.push('#pending = :pending');
    exprValues[':pending'] = values;
    exprValues[':status'] = LifecycleStatus.UPDATING;
    exprValues[':active'] = LifecycleStatus.ACTIVE;
    exprValues[':updateFailed'] = LifecycleStatus.UPDATE_FAILED;
    conditions.push('(attribute_not_exists(#status) OR #status IN (:active, :updateFailed))');
  } else {
    exprValues[':status'] = LifecycleStatus.CREATING;
    const fields: (keyof ApplicationPending)[] = [
      'source',
      'cellScripts',
      'tenantScripts',
      'maxTenants',
      'placementStrategy',
      'parameters',
      'cellParameters',
      'hooks',
    ];
    for (const field of fields) {
      if (values[field] !== undefined) {
        names[`#${field}`] = field;
        exprValues[`:${field}`] = values[field];
        sets.push(`#${field} = :${field}`);
      }
    }
    if (path === 'CREATE') {
      conditions.push('attribute_not_exists(PK)');
    } else {
      exprValues[':createFailed'] = LifecycleStatus.CREATE_FAILED;
      conditions.push('#status = :createFailed');
    }
  }

  if (path !== 'CREATE') {
    const sameOperation = operationIdAsRead(input.read?.operationId);
    conditions.push(sameOperation.conditionExpression);
    Object.assign(exprValues, sameOperation.expressionAttributeValues);
    for (const attribute of ['parameters', 'cellParameters'] as const) {
      if (values[attribute] !== undefined) {
        continue;
      }
      const name = `#${attribute}`;
      names[name] = attribute;
      const read = input.read?.[attribute];
      if (read === undefined) {
        conditions.push(`attribute_not_exists(${name})`);
      } else {
        conditions.push(`${name} = :read_${attribute}`);
        exprValues[`:read_${attribute}`] = read;
      }
    }
  }

  return {
    updateExpression: `SET ${sets.join(', ')}` + (path === 'CREATE' ? '' : ' REMOVE #statusReason'),
    conditionExpression: conditions.join(' AND '),
    expressionAttributeNames: path === 'CREATE' ? names : { ...names, '#statusReason': 'statusReason' },
    expressionAttributeValues: exprValues,
  };
}

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
      hooks: record.hooks,
      cellCount: record.cellCount,
      status: record.status,
      statusReason: record.statusReason,
      lastGlobalHooks: record.lastGlobalHooks,
      pending: readApplicationPending(record.pending),
      operationId: record.operationId,
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
      hooks: item.hooks,
      cellCount: item.cellCount,
      status: readRecordStatus(item.status),
      statusReason: item.statusReason,
      lastGlobalHooks: item.lastGlobalHooks === undefined ? undefined : readLastGlobalHooks(item.lastGlobalHooks),
      pending: readApplicationPending(item.pending),
      operationId: item.operationId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
