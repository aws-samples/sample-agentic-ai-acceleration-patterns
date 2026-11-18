// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Meter operations (spec §4.1, P-6, ADR-0004). A meter is a chain of
 * versions; every change writes a new version that counts from the next
 * whole hour, so an hour is always counted under one version. `CURRENT`
 * holds the latest version number and is the fence of every write.
 */

import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type AdminContext, type AdminDeps, nowOf, toDate } from './deps';
import { apiError } from './errors';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import type { SumRule } from '../recount/rule';
import { getItem, meterVersions } from '../shared/db';
import type { MeterCurrentItem, MeterVersionItem } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { addHours, hourSpan, iso, isHourKey, nextWholeHour } from '../shared/time';
import { hourOf } from '../shared/usage-event';
import type { MeterVersion } from '../smithy/metering/typescript-ssdk-codegen/src';

export function meterOut(item: MeterVersionItem): MeterVersion {
  return {
    meterId: item.meterId,
    version: item.version,
    unit: item.unit,
    rule: item.rule,
    allowedApplications: item.allowedApplications,
    effectiveFrom: item.effectiveFrom,
    status: item.status,
    createdBy: item.createdBy,
    createdAt: toDate(item.createdAt),
  };
}

/**
 * `effectiveFrom` of a new meter: the next whole hour, or an earlier whole
 * hour at most `recountWindowHours` back (spec §4.1).
 */
export function createEffectiveFrom(requested: string | undefined, nowMs: number, recountWindowHours: number): string {
  const next = nextWholeHour(nowMs);
  if (requested === undefined) {
    return next;
  }
  if (!isHourKey(requested)) {
    throw apiError.validation('effectiveFrom is not an hour');
  }
  const earliest = addHours(hourOf(new Date(nowMs)), -recountWindowHours);
  if (hourSpan(requested, next) < 0 || hourSpan(earliest, requested) < 0) {
    throw apiError.validation('effectiveFrom must be the next whole hour or an earlier hour inside the recount window');
  }
  return requested;
}

function applications(value: string[] | undefined): string[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return [...new Set(value)].sort();
}

async function current(deps: AdminDeps, meterId: string): Promise<{ head: MeterCurrentItem; latest: MeterVersionItem }> {
  const head = await getItem<MeterCurrentItem>(deps.db, deps.config.tableName, keys.meterCurrent(meterId), true);
  if (head === undefined) {
    throw apiError.notFound('no such meter');
  }
  const latest = await getItem<MeterVersionItem>(deps.db, deps.config.tableName, keys.meterVersion(meterId, head.latest), true);
  if (latest === undefined) {
    throw apiError.internal();
  }
  return { head, latest };
}

/** Writes the next version under a condition that `CURRENT` has not moved. */
async function writeVersion(deps: AdminDeps, head: MeterCurrentItem | undefined, item: MeterVersionItem): Promise<void> {
  const tableName = deps.config.tableName;
  const currentKey = keys.meterCurrent(item.meterId);
  try {
    await deps.db.send(
      new TransactWriteCommand({
        TransactItems: [
          head === undefined
            ? {
              Put: {
                TableName: tableName,
                Item: { ...currentKey, meterId: item.meterId, latest: item.version, listType: 'METER', listSort: item.meterId },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            }
            : {
              Update: {
                TableName: tableName,
                Key: currentKey,
                UpdateExpression: 'SET latest = :next',
                ConditionExpression: 'latest = :seen',
                ExpressionAttributeValues: { ':next': item.version, ':seen': head.latest },
              },
            },
          { Put: { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      throw head === undefined
        ? apiError.conflict('ALREADY_EXISTS', 'a meter with this id exists')
        : apiError.conflict('CONCURRENT_WRITE', 'the meter changed; read it and retry');
    }
    throw error;
  }
}

export async function createMeter(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { meterId: string; unit: string; rule: SumRule; allowedApplications?: string[]; effectiveFrom?: string },
): Promise<MeterVersionItem> {
  const nowMs = nowOf(deps);
  const item: MeterVersionItem = {
    ...keys.meterVersion(input.meterId, 1),
    meterId: input.meterId,
    version: 1,
    unit: input.unit,
    rule: input.rule,
    allowedApplications: applications(input.allowedApplications),
    effectiveFrom: createEffectiveFrom(input.effectiveFrom, nowMs, deps.config.recountWindowHours),
    status: 'ACTIVE',
    createdBy: ctx.caller.roleArn,
    createdAt: iso(nowMs),
  };
  await writeVersion(deps, undefined, item);
  return item;
}

export async function getMeter(
  deps: AdminDeps,
  meterId: string,
  all: boolean,
): Promise<{ meter: MeterVersionItem; versions?: MeterVersionItem[] }> {
  const { latest } = await current(deps, meterId);
  return { meter: latest, versions: all ? await meterVersions(deps.db, deps.config.tableName, meterId, true) : undefined };
}

export async function updateMeter(
  deps: AdminDeps,
  ctx: AdminContext,
  input: { meterId: string; unit?: string; rule?: SumRule; allowedApplications?: string[] },
): Promise<MeterVersionItem> {
  const nowMs = nowOf(deps);
  const { head, latest } = await current(deps, input.meterId);
  const item: MeterVersionItem = {
    ...keys.meterVersion(input.meterId, head.latest + 1),
    meterId: input.meterId,
    version: head.latest + 1,
    unit: input.unit ?? latest.unit,
    rule: input.rule ?? latest.rule,
    allowedApplications: input.allowedApplications === undefined ? latest.allowedApplications : applications(input.allowedApplications),
    effectiveFrom: nextWholeHour(nowMs),
    // An update writes an ACTIVE version, so it also brings back a retired meter.
    status: 'ACTIVE',
    createdBy: ctx.caller.roleArn,
    createdAt: iso(nowMs),
  };
  await writeVersion(deps, head, item);
  return item;
}

export async function deleteMeter(deps: AdminDeps, ctx: AdminContext, meterId: string): Promise<MeterVersionItem> {
  const nowMs = nowOf(deps);
  const { head, latest } = await current(deps, meterId);
  if (latest.status === 'RETIRED') {
    return latest;
  }
  const item: MeterVersionItem = {
    ...latest,
    ...keys.meterVersion(meterId, head.latest + 1),
    version: head.latest + 1,
    effectiveFrom: nextWholeHour(nowMs),
    status: 'RETIRED',
    createdBy: ctx.caller.roleArn,
    createdAt: iso(nowMs),
  };
  await writeVersion(deps, head, item);
  return item;
}

export async function listMeters(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ meters: MeterVersionItem[]; nextToken?: string }> {
  const query = 'ListMeters';
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      IndexName: LIST_BY_TYPE_INDEX,
      KeyConditionExpression: 'listType = :t',
      ExpressionAttributeValues: { ':t': 'METER' },
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  const meters: MeterVersionItem[] = [];
  for (const head of (page.Items ?? []) as MeterCurrentItem[]) {
    const out = await deps.db.send(new GetCommand({ TableName: deps.config.tableName, Key: keys.meterVersion(head.meterId, head.latest) }));
    if (out.Item !== undefined) {
      meters.push(out.Item as MeterVersionItem);
    }
  }
  return { meters, nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined) };
}
