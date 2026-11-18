// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The record publisher (spec §4.7). The table is the outbox: a usage record
 * is written with a `publishPending` marker, and the publisher, for each
 * record whose marker arrives (from the table's stream, or from the sweep of
 * markers older than 15 minutes):
 *
 * 1. publishes `UsageRecorded` on the usage bus, deduplicated on
 *    `<recordId>#<revision>`;
 * 2. queues one delivery per sink: at revision 1 every sink of the record
 *    not yet sent, at revision 2 only the `BLOCKED` ones;
 * 3. removes the marker, on a condition that the record is still at the
 *    revision it published, so a later revision's marker stays.
 */

import { type EventBridgeV2Client, PutEventsCommand } from '@aws-sdk/client-eventbridgev2';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getItem } from '../shared/db';
import type { DeliveryMessage, UsageRecordItem } from '../shared/items';
import { PUBLISH_OUTBOX_INDEX, PUBLISH_SHARDS } from '../shared/keys';
import { log } from '../shared/logger';
import { METRIC, type Metrics } from '../shared/metrics';
import { chunk, isConditionFailure, withRetry } from '../shared/retry';
import { iso, MINUTE_MS } from '../shared/time';

export const USAGE_SOURCE = 'metering.usage';
export const USAGE_DETAIL_TYPE = 'UsageRecorded';
/** The sweep publishes markers older than this (spec §4.7). */
export const SWEEP_AGE_MS = 15 * MINUTE_MS;

export interface PublisherDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly eventBridge: EventBridgeV2Client;
  readonly usageBusArn: string;
  readonly sqs: SQSClient;
  readonly deliveryQueueUrl: string;
  readonly metrics: Metrics;
  readonly now?: () => number;
}

/** The `UsageRecorded` detail (spec §4.8, part of the published interface). */
export function usageRecordedDetail(record: UsageRecordItem): Record<string, unknown> {
  return {
    recordId: record.recordId,
    revision: record.revision,
    kind: record.kind,
    tenantId: record.tenantId,
    applicationId: record.applicationId,
    meterId: record.meterId,
    meterVersion: record.meterVersion,
    unit: record.unit,
    hour: record.hour,
    seq: record.seq,
    quantity: record.quantity,
    total: record.total,
    eventCount: record.eventCount,
    ...(record.billingAccount !== undefined ? { billingAccount: record.billingAccount } : {}),
  };
}

/** The sinks a publish of this revision queues. */
export function sinksToQueue(record: UsageRecordItem): string[] {
  return Object.entries(record.sinks ?? {})
    .filter(([, state]) => (record.revision >= 2 ? state.status === 'BLOCKED' : state.status !== 'SENT' && state.status !== 'FAILED'))
    .map(([sinkId]) => sinkId)
    .sort();
}

/** Whether a stream record carries a marker that just arrived. */
export function markerArrived(newImage: Partial<UsageRecordItem> | undefined, oldImage: Partial<UsageRecordItem> | undefined): boolean {
  if (newImage === undefined || typeof newImage.PK !== 'string' || !newImage.PK.startsWith('USAGE#') || newImage.publishPending === undefined) {
    return false;
  }
  return oldImage?.publishPending === undefined || oldImage.publishPending !== newImage.publishPending;
}

export class Publisher {
  private readonly now: () => number;

  constructor(private readonly deps: PublisherDeps) {
    this.now = deps.now ?? Date.now;
  }

  async publish(record: UsageRecordItem): Promise<void> {
    const { db, tableName, metrics } = this.deps;
    const out = await withRetry(() =>
      this.deps.eventBridge.send(
        new PutEventsCommand({
          EventBusArn: this.deps.usageBusArn,
          Entries: [
            {
              Source: USAGE_SOURCE,
              DetailType: USAGE_DETAIL_TYPE,
              Detail: JSON.stringify(usageRecordedDetail(record)),
              SystemMetadata: { DeduplicationId: `${record.recordId}#${record.revision}`, EventGroupId: record.tenantId },
            },
          ],
        }),
      ),
    );
    const code = out.Entries?.[0]?.SuccessCode;
    if (code !== 'PUBLISHED' && code !== 'DEDUPLICATED') {
      throw new Error(`UsageRecorded not published: ${out.Entries?.[0]?.ErrorCode ?? 'unknown'}`);
    }

    const firstQueuedAt = iso(this.now());
    const messages: DeliveryMessage[] = sinksToQueue(record).map((sinkId) => ({ PK: record.PK, SK: record.SK, sinkId, firstQueuedAt }));
    for (const batch of chunk(messages, 10)) {
      const sent = await this.deps.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.deps.deliveryQueueUrl,
          Entries: batch.map((message, i) => ({ Id: String(i), MessageBody: JSON.stringify(message) })),
        }),
      );
      if ((sent.Failed ?? []).length > 0) {
        throw new Error('deliveries not queued');
      }
    }

    try {
      await withRetry(() =>
        db.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: record.PK, SK: record.SK },
            UpdateExpression: 'REMOVE publishPending, publishShard',
            ConditionExpression: 'revision = :rev AND publishPending = :marker',
            ExpressionAttributeValues: { ':rev': record.revision, ':marker': record.publishPending },
          }),
        ),
      );
    } catch (error) {
      if (!isConditionFailure(error)) {
        throw error;
      }
    }
    metrics.add(METRIC.published);
  }

  /** Publishes every record whose marker is older than 15 minutes (spec §4.7). */
  async sweep(): Promise<number> {
    const { db, tableName } = this.deps;
    const cutoff = iso(this.now() - SWEEP_AGE_MS);
    let count = 0;
    for (let shard = 0; shard < PUBLISH_SHARDS; shard++) {
      let start: Record<string, unknown> | undefined;
      do {
        const page = await withRetry(() =>
          db.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: PUBLISH_OUTBOX_INDEX,
              KeyConditionExpression: 'publishShard = :s AND publishPending < :cutoff',
              ExpressionAttributeValues: { ':s': shard, ':cutoff': cutoff },
              ExclusiveStartKey: start,
            }),
          ),
        );
        for (const key of page.Items ?? []) {
          const record = await getItem<UsageRecordItem>(db, tableName, { PK: String(key.PK), SK: String(key.SK) }, true);
          if (record?.publishPending !== undefined) {
            await this.publish(record);
            count++;
          }
        }
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
    }
    if (count > 0) {
      log.warn('swept unpublished records', { count });
    }
    return count;
  }
}
