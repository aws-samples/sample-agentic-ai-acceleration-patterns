// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Usage and hour reads (spec §4.5, §4.7, §5).
 */

import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AdminDeps } from './deps';
import { toDate } from './deps';
import { apiError } from './errors';
import { checkRange } from './jobs';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import { getItem } from '../shared/db';
import type { HourItem, UsageRecordItem } from '../shared/items';
import { keys, PENDING, PENDING_HOURS_INDEX } from '../shared/keys';
import type { HourSummary, UsageRecord } from '../smithy/metering/typescript-ssdk-codegen/src';

export function recordOut(item: UsageRecordItem): UsageRecord {
  return {
    recordId: item.recordId,
    kind: item.kind,
    tenantId: item.tenantId,
    applicationId: item.applicationId,
    meterId: item.meterId,
    meterVersion: item.meterVersion,
    hour: item.hour,
    seq: item.seq,
    revision: item.revision,
    quantity: item.quantity,
    total: item.total,
    eventCount: item.eventCount,
    billingAccount: item.billingAccount,
    sinks: item.sinks,
  };
}

export function hourOut(item: HourItem, generation: number): HourSummary {
  return {
    hour: item.hour,
    status: item.status,
    generation,
    countedGeneration: item.countedGeneration,
    countedAt: toDate(item.countedAt),
    attempts: item.attempts ?? 0,
  };
}

/**
 * Records of one tenant and application in an hour range, optionally one
 * meter. The sort key starts with the hour, so the range is a key condition
 * and the meter a filter.
 */
export async function readUsage(
  deps: AdminDeps,
  input: { tenantId: string; applicationId: string; meterId?: string; from: string; to: string; nextToken?: string; maxResults?: number },
): Promise<{ records: UsageRecordItem[]; nextToken?: string }> {
  checkRange(input.from, input.to);
  const query = `Usage#${input.tenantId}#${input.applicationId}#${input.meterId ?? '*'}#${input.from}#${input.to}`;
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ...(input.meterId !== undefined ? { FilterExpression: 'meterId = :m' } : {}),
      ExpressionAttributeValues: {
        ':pk': keys.usagePk(input.tenantId, input.applicationId),
        ':from': `${input.from}#`,
        ':to': `${input.to}#~`,
        ...(input.meterId !== undefined ? { ':m': input.meterId } : {}),
      },
      Limit: input.maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, input.nextToken),
    }),
  );
  return {
    records: (page.Items ?? []) as UsageRecordItem[],
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}

async function generations(deps: AdminDeps, hours: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (hours.length === 0) {
    return out;
  }
  const result = await deps.db.send(
    new BatchGetCommand({
      RequestItems: { [deps.config.tableName]: { Keys: hours.map((hour) => keys.hourGeneration(hour)), ConsistentRead: true } },
    }),
  );
  for (const item of result.Responses?.[deps.config.tableName] ?? []) {
    out.set(String(item.PK).slice('HOUR#'.length), Number(item.generation ?? 0));
  }
  return out;
}

export async function getHour(deps: AdminDeps, hour: string): Promise<HourSummary> {
  const item = await getItem<HourItem>(deps.db, deps.config.tableName, keys.hour(hour), true);
  if (item === undefined) {
    throw apiError.notFound('no such hour');
  }
  const gen = await getItem<{ generation?: number }>(deps.db, deps.config.tableName, keys.hourGeneration(hour), true);
  return hourOut(item, Number(gen?.generation ?? 0));
}

/** Hours that are not `CLOSED`, oldest first. */
export async function listHours(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ hours: HourSummary[]; nextToken?: string }> {
  const query = 'ListHours';
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      IndexName: PENDING_HOURS_INDEX,
      KeyConditionExpression: 'pending = :p',
      ExpressionAttributeValues: { ':p': PENDING },
      Limit: Math.min(maxResults ?? DEFAULT_PAGE_SIZE, 100),
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  const items = (page.Items ?? []) as HourItem[];
  const gens = await generations(
    deps,
    items.map((item) => item.hour),
  );
  return {
    hours: items.map((item) => hourOut(item, gens.get(item.hour) ?? 0)),
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string | number> | undefined),
  };
}
