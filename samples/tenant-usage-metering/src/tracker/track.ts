// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The object tracker (spec §4.5). For every new object under `raw/` or
 * `readmitted/`: create the hour's `META` item `OPEN` if absent, and add one
 * to `generation` on its `GEN` item, whatever the hour's state. The tracker
 * never writes `META` otherwise, so it never touches what the recount's
 * fence checks. The scheduler replays failed invocations through the same
 * function (src/scheduler/scheduler.ts).
 */

import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Event } from 'aws-lambda';
import { getItem } from '../shared/db';
import type { HourItem } from '../shared/items';
import { keys, PENDING } from '../shared/keys';
import { log } from '../shared/logger';
import { METRIC, type Metrics } from '../shared/metrics';
import { isConditionFailure, withRetry } from '../shared/retry';
import { isHourKey } from '../shared/time';

const TRACKED = /^(raw|readmitted)\/hour=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2})\//;

/** The hour of a tracked object key, or `undefined` for any other key. */
export function hourOfObjectKey(key: string): string | undefined {
  const match = TRACKED.exec(key);
  return match !== null && isHourKey(match[2]) ? match[2] : undefined;
}

/** S3 event keys are URL-encoded with `+` for spaces. */
export function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

/** Marks one hour as holding a new object. */
export async function trackHour(db: DynamoDBDocumentClient, tableName: string, hour: string, metrics: Metrics): Promise<void> {
  try {
    await withRetry(() =>
      db.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...keys.hour(hour), hour, status: 'OPEN', attempts: 0, pending: PENDING },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      ),
    );
  } catch (error) {
    if (!isConditionFailure(error)) {
      throw error;
    }
    const meta = await getItem<HourItem>(db, tableName, keys.hour(hour));
    if (meta?.status === 'CLOSED') {
      metrics.add(METRIC.objectInClosedHour);
      log.warn('object landed in a closed hour', { hour });
    }
  }
  await withRetry(() =>
    db.send(
      new UpdateCommand({
        TableName: tableName,
        Key: keys.hourGeneration(hour),
        UpdateExpression: 'ADD generation :one',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    ),
  );
}

/**
 * Tracks every record of an S3 event. An object under `firehose-error/` is
 * not counted by the recount, so it only raises its alarm (spec §3.1); any
 * other key is ignored.
 */
export async function trackS3Event(db: DynamoDBDocumentClient, tableName: string, event: S3Event, metrics: Metrics): Promise<void> {
  for (const record of event.Records ?? []) {
    const key = decodeS3Key(record.s3.object.key);
    if (key.startsWith('firehose-error/')) {
      metrics.add(METRIC.firehoseErrorObject);
      log.error('Firehose wrote an error object', { step: 'firehose-error' });
      continue;
    }
    const hour = hourOfObjectKey(key);
    if (hour !== undefined) {
      await trackHour(db, tableName, hour, metrics);
    }
  }
}
