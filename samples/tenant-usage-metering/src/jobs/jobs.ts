// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The jobs that run under the admin role (spec §4.6, §4.7): `RECOUNT`,
 * `SINK_REDRIVE` and `RESEND_BLOCKED`.
 *
 * - `RECOUNT` adds one to `generation` of each hour in range, the path a new
 *   object takes, so the scheduler counts it again; the close guard is
 *   checked before each write.
 * - `SINK_REDRIVE` sets a sink's `FAILED` deliveries (or, with an hour
 *   range, every record of the range that takes the sink's meter) back to
 *   `PENDING` and queues them. The table has no index by hour or by sink
 *   state, so it scans usage records: an operator job, run rarely.
 * - `RESEND_BLOCKED` writes a tenant and application's newly known billing
 *   account onto records with a `BLOCKED` sink as revision 2 (the publisher
 *   queues them), or queues the `BLOCKED` sinks of a record already at
 *   revision 2.
 */

import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { JobStore } from './job-store';
import { getItem, queryAll, tenantBindings } from '../shared/db';
import {
  billingBinding,
  type DeliveryMessage,
  type HourItem,
  type JobCounts,
  type JobItem,
  type SinkItem,
  sinkTakes,
  type UsageRecordItem,
} from '../shared/items';
import { keys, publishShard } from '../shared/keys';
import { chunk, isConditionFailure, withRetry } from '../shared/retry';
import { hoursBetween, iso, pastCloseGuard } from '../shared/time';

export interface JobsDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly sqs: SQSClient;
  readonly deliveryQueueUrl: string;
  readonly recountWindowHours: number;
  readonly now?: () => number;
}

export class Jobs {
  private readonly now: () => number;
  readonly store: JobStore;

  constructor(private readonly deps: JobsDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new JobStore(deps.db, deps.tableName, this.now);
  }

  async recount(job: JobItem, counts: JobCounts, outOfTime: () => boolean): Promise<void> {
    const { db, tableName, recountWindowHours } = this.deps;
    for (const hour of hoursBetween(job.from!, job.to!)) {
      if (outOfTime()) {
        return;
      }
      counts.processed++;
      const meta = await getItem<HourItem>(db, tableName, keys.hour(hour), true);
      if (meta === undefined) {
        continue; // no object ever landed: nothing to count
      }
      if (meta.status === 'CLOSED' || pastCloseGuard(hour, this.now(), recountWindowHours)) {
        counts.refused++;
        continue;
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
      counts.admitted++;
    }
  }

  private async queue(records: ReadonlyArray<UsageRecordItem>, sinkId: string): Promise<void> {
    const firstQueuedAt = iso(this.now());
    for (const batch of chunk(records, 10)) {
      const out = await this.deps.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.deps.deliveryQueueUrl,
          Entries: batch.map((record, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify({ PK: record.PK, SK: record.SK, sinkId, firstQueuedAt } satisfies DeliveryMessage),
          })),
        }),
      );
      if ((out.Failed ?? []).length > 0) {
        throw new Error('deliveries not queued');
      }
    }
  }

  async sinkRedrive(job: JobItem, counts: JobCounts, outOfTime: () => boolean): Promise<void> {
    const { db, tableName } = this.deps;
    const sink = await getItem<SinkItem>(db, tableName, keys.sink(job.sinkId!), true);
    if (sink === undefined) {
      throw new Error('the sink was deleted');
    }
    const backfill = job.from !== undefined && job.to !== undefined;
    let start: Record<string, unknown> | undefined;
    do {
      if (outOfTime()) {
        return;
      }
      const page = await withRetry(() =>
        db.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: backfill
              ? 'begins_with(PK, :usage) AND #h BETWEEN :from AND :to'
              : 'begins_with(PK, :usage) AND sinks.#sink.#st = :failed',
            ExpressionAttributeNames: backfill ? { '#h': 'hour' } : { '#sink': sink.sinkId, '#st': 'status' },
            ExpressionAttributeValues: backfill
              ? { ':usage': 'USAGE#', ':from': job.from, ':to': job.to }
              : { ':usage': 'USAGE#', ':failed': 'FAILED' },
            ExclusiveStartKey: start,
          }),
        ),
      );
      const picked: UsageRecordItem[] = [];
      for (const record of (page.Items ?? []) as UsageRecordItem[]) {
        counts.processed++;
        if (backfill && !sinkTakes(sink, record.meterId)) {
          continue;
        }
        // A backfill adds the sink to a record that never had it (a sink
        // enabled later); a redrive only resets a FAILED delivery.
        const update: Pick<
          UpdateCommandInput,
          'UpdateExpression' | 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
        > = backfill
          ? record.sinks === undefined
            ? {
              UpdateExpression: 'SET sinks = :map',
              ConditionExpression: 'attribute_not_exists(sinks)',
              ExpressionAttributeValues: { ':map': { [sink.sinkId]: { status: 'PENDING' } } },
            }
            : {
              UpdateExpression: 'SET sinks.#sink = :pending',
              ConditionExpression: 'attribute_exists(sinks)',
              ExpressionAttributeNames: { '#sink': sink.sinkId },
              ExpressionAttributeValues: { ':pending': { status: 'PENDING' } },
            }
          : {
            UpdateExpression: 'SET sinks.#sink = :pending',
            ConditionExpression: 'sinks.#sink.#st = :failed',
            ExpressionAttributeNames: { '#sink': sink.sinkId, '#st': 'status' },
            ExpressionAttributeValues: { ':pending': { status: 'PENDING' }, ':failed': 'FAILED' },
          };
        try {
          await withRetry(() => db.send(new UpdateCommand({ TableName: tableName, Key: { PK: record.PK, SK: record.SK }, ...update })));
          picked.push(record);
        } catch (error) {
          if (!isConditionFailure(error)) {
            throw error;
          }
        }
      }
      await this.queue(picked, sink.sinkId);
      counts.redriven += picked.length;
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
  }

  async resendBlocked(job: JobItem, counts: JobCounts, outOfTime: () => boolean): Promise<void> {
    const { db, tableName } = this.deps;
    const records = await queryAll<UsageRecordItem>(db, {
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.usagePk(job.tenantId!, job.applicationId!) },
      ConsistentRead: true,
    });
    const billingAccount = billingBinding(await tenantBindings(db, tableName, job.tenantId!, job.applicationId!, true))?.billingAccount;
    for (const record of records) {
      if (outOfTime()) {
        return;
      }
      const blocked = Object.entries(record.sinks ?? {})
        .filter(([, state]) => state.status === 'BLOCKED')
        .map(([sinkId]) => sinkId);
      if (blocked.length === 0) {
        continue;
      }
      counts.processed++;
      if (record.revision >= 2) {
        for (const sinkId of blocked) {
          await this.queue([record], sinkId);
        }
        counts.redriven += blocked.length;
        continue;
      }
      if (billingAccount === undefined) {
        counts.refused++;
        continue;
      }
      try {
        await withRetry(() =>
          db.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { PK: record.PK, SK: record.SK },
              UpdateExpression: 'SET billingAccount = :ba, revision = :two, publishPending = :marker, publishShard = :shard',
              ConditionExpression: 'revision = :one',
              ExpressionAttributeValues: {
                ':ba': billingAccount,
                ':two': 2,
                ':one': 1,
                ':marker': iso(this.now()),
                ':shard': publishShard(record.recordId),
              },
            }),
          ),
        );
        counts.admitted++;
      } catch (error) {
        if (!isConditionFailure(error)) {
          throw error;
        }
        // Written as revision 2 in between: its publish queues the BLOCKED sinks.
      }
    }
  }
}
