// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Table access shared by the functions: one document client per container
 * and the reads more than one function makes.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { BindingItem, MeterVersionItem, SinkItem } from './items';
import { keys, LIST_BY_TYPE_INDEX, type ListType } from './keys';
import { withRetry } from './retry';

let client: DynamoDBDocumentClient | undefined;

export function documentClient(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return client;
}

/** Every item of a query, page by page. */
export async function queryAll<T>(db: DynamoDBDocumentClient, input: QueryCommandInput): Promise<T[]> {
  const out: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await withRetry(() => db.send(new QueryCommand({ ...input, ExclusiveStartKey: start })));
    out.push(...((page.Items ?? []) as T[]));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

export async function getItem<T>(
  db: DynamoDBDocumentClient,
  tableName: string,
  key: { PK: string; SK: string },
  consistent = false,
): Promise<T | undefined> {
  const out = await withRetry(() => db.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: consistent })));
  return out.Item as T | undefined;
}

/** Every version of a meter, oldest first. */
export async function meterVersions(
  db: DynamoDBDocumentClient,
  tableName: string,
  meterId: string,
  consistent = false,
): Promise<MeterVersionItem[]> {
  return queryAll<MeterVersionItem>(db, {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :v)',
    ExpressionAttributeValues: { ':pk': keys.meterPk(meterId), ':v': 'V#' },
    ConsistentRead: consistent,
  });
}

/** A tenant's bindings for one application, every cell (spec §4.3 lookup item). */
export async function tenantBindings(
  db: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  applicationId: string,
  consistent = false,
): Promise<BindingItem[]> {
  return queryAll<BindingItem>(db, {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': keys.tenantPk(tenantId), ':sk': keys.bindingLookupPrefix(applicationId) },
    ConsistentRead: consistent,
  });
}

/** Every item of one listable kind, through the `list-by-type` index. */
export async function listAllOfType<T>(db: DynamoDBDocumentClient, tableName: string, listType: ListType): Promise<T[]> {
  return queryAll<T>(db, {
    TableName: tableName,
    IndexName: LIST_BY_TYPE_INDEX,
    KeyConditionExpression: 'listType = :t',
    ExpressionAttributeValues: { ':t': listType },
  });
}

/** Every sink, read from the base table so a just-written sink is seen. */
export async function allSinks(db: DynamoDBDocumentClient, tableName: string): Promise<SinkItem[]> {
  const listed = await listAllOfType<{ PK: string; SK: string }>(db, tableName, 'SINK');
  const sinks: SinkItem[] = [];
  for (const item of listed) {
    const sink = await getItem<SinkItem>(db, tableName, { PK: item.PK, SK: item.SK }, true);
    if (sink !== undefined) {
      sinks.push(sink);
    }
  }
  return sinks;
}
