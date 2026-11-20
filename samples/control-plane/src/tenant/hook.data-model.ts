// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  GlobalHookRecord,
  HOOK_COUNTER_SORT_KEY,
  HOOK_PARTITION_KEY,
  HOOK_SORT_KEY_PREFIX,
  HookDefinition,
  LastGlobalHookEntry,
} from './hook.types';
import { DataModel, DynamoDBItem } from '../shared/data-model';
import { ItemKey, ItemUpdate, PartitionQuery } from '../shared/repository';

/**
 * Storage of global hooks (spec §4.8, R-39, R-40): one base-table partition,
 * `PK=HOOK`, one item per hook at `SK=HOOK#<hookId>` and the counter at
 * `SK=META`. The partition is read in one strongly consistent query, so
 * hook items carry no index attributes.
 */

/** Base-table key of a global hook. */
export function hookKey(hookId: string): ItemKey {
  return { PK: HOOK_PARTITION_KEY, SK: `${HOOK_SORT_KEY_PREFIX}${hookId}` };
}

/**
 * Base-table key of the hook counter, `hookCount` (P-6). Written only by the
 * two transactions of `HookTransactions`.
 */
export function hookCounterKey(): ItemKey {
  return { PK: HOOK_PARTITION_KEY, SK: HOOK_COUNTER_SORT_KEY };
}

/**
 * Base-table query serving `ListHooks` and hook resolution at accept time
 * (§4.7, R-10, R-40): the static `HOOK` partition, the `HOOK#` sort-key
 * prefix (which leaves the counter out), strongly consistent. Items come
 * back in `hookId` order, the order global hooks run in (R-45).
 */
export function listHooksQuery(): PartitionQuery {
  return { partitionKey: HOOK_PARTITION_KEY, sortKeyPrefix: HOOK_SORT_KEY_PREFIX, consistentRead: true };
}

/** DynamoDB item representation of a {@link GlobalHookRecord}. */
export interface HookItem extends DynamoDBItem {
  readonly hookId: string;
  readonly events: readonly string[];
  readonly phase: string;
  readonly source: { readonly type: string; readonly location: string; readonly sourceVersion?: string };
  readonly script: string;
  readonly timeoutMinutes: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The replace write of `PutHook` for an existing hook (R-39): ONE
 * `UpdateItem` that sets the definition and `revision = revision + 1`. The
 * repository's `updateExisting` adds the `attribute_exists(PK)` condition, so
 * a replace that meets a concurrent delete fails instead of recreating the
 * hook without its counter slot. `createdAt` and the counter are untouched.
 */
export function replaceHookUpdate(definition: HookDefinition, now: string): ItemUpdate {
  return {
    updateExpression:
      'SET #events = :events, #phase = :phase, #source = :source, #script = :script, '
      + '#timeoutMinutes = :timeoutMinutes, #revision = #revision + :one, #updatedAt = :now',
    expressionAttributeNames: {
      '#events': 'events',
      '#phase': 'phase',
      '#source': 'source',
      '#script': 'script',
      '#timeoutMinutes': 'timeoutMinutes',
      '#revision': 'revision',
      '#updatedAt': 'updatedAt',
    },
    expressionAttributeValues: {
      ':events': [...definition.events],
      ':phase': definition.phase,
      ':source': storedSource(definition),
      ':script': definition.script,
      ':timeoutMinutes': definition.timeoutMinutes,
      ':one': 1,
      ':now': now,
    },
  };
}

function storedSource(definition: HookDefinition): HookItem['source'] {
  const { type, location, sourceVersion } = definition.source;
  return sourceVersion === undefined ? { type, location } : { type, location, sourceVersion };
}

/** Converts between {@link GlobalHookRecord} and its DynamoDB item. */
export class HookDataModel implements DataModel<GlobalHookRecord, HookItem> {
  toItem(record: GlobalHookRecord): HookItem {
    return {
      ...hookKey(record.hookId),
      hookId: record.hookId,
      events: [...record.events],
      phase: record.phase,
      source: storedSource(record),
      script: record.script,
      timeoutMinutes: record.timeoutMinutes,
      revision: record.revision,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: HookItem): GlobalHookRecord {
    return {
      hookId: item.hookId,
      events: item.events as GlobalHookRecord['events'],
      phase: item.phase as GlobalHookRecord['phase'],
      source: item.source as GlobalHookRecord['source'],
      script: item.script,
      timeoutMinutes: item.timeoutMinutes,
      revision: item.revision,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}

/**
 * Reads a stored `lastGlobalHooks` attribute (R-40). The workflow's terminal
 * writes put one map per hook that ran, with `sourceVersion` and
 * `resolvedSourceVersion` as strings; an empty string means absent (the
 * workflow reads a hook with no ref as '' and an S3 build reports no commit),
 * so the API reports those two fields only when they hold a value. An absent
 * attribute is an empty list.
 */
export function readLastGlobalHooks(stored: readonly StoredLastGlobalHook[] | undefined): LastGlobalHookEntry[] {
  return (stored ?? []).map((entry) => ({
    hookId: entry.hookId,
    phase: entry.phase,
    revision: Number(entry.revision),
    ...(entry.sourceVersion ? { sourceVersion: entry.sourceVersion } : {}),
    ...(entry.resolvedSourceVersion ? { resolvedSourceVersion: entry.resolvedSourceVersion } : {}),
  }));
}

/** One `lastGlobalHooks` entry as the workflow stores it (list of maps). */
export interface StoredLastGlobalHook {
  readonly hookId: string;
  readonly phase: LastGlobalHookEntry['phase'];
  readonly revision: number;
  readonly sourceVersion?: string;
  readonly resolvedSourceVersion?: string;
}
