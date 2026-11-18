// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The scheduler (spec §3.1, §4.5), every 5 minutes:
 *
 * 1. query the `pending` index, which holds every hour that is not `CLOSED`,
 *    and read each hour's `GEN` item;
 * 2. a `COUNTED` hour whose `generation` moved past `countedGeneration`
 *    becomes `DIRTY`; a `COUNTED` hour past its close time closes, or
 *    becomes `DIRTY` if its `generation` moved;
 * 3. start a recounter execution for each hour that is due (the execution
 *    takes the hour itself, so a duplicate start is harmless);
 * 4. replay the object tracker's failed invocations.
 *
 * The `publishPending` sweep runs under the record publisher's role on its
 * own schedule (src/publisher/publisher.ts).
 */

import { type SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { BatchGetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Event } from 'aws-lambda';
import { ulid } from 'ulid';
import { takeable } from '../recount/count';
import { queryAll } from '../shared/db';
import type { HourItem } from '../shared/items';
import { keys, PENDING, PENDING_HOURS_INDEX } from '../shared/keys';
import { errorName, log } from '../shared/logger';
import { METRIC, type Metrics } from '../shared/metrics';
import { cancellationCodes, chunk, isConditionFailure, withRetry } from '../shared/retry';
import { closeTimeMs, MINUTE_MS } from '../shared/time';
import { hourEndMs } from '../shared/usage-event';
import { trackS3Event } from '../tracker/track';

/** Executions started per run; the rest wait for the next run. */
export const MAX_STARTS_PER_RUN = 100;
/** Tracker failures replayed per run. */
const MAX_REPLAYS_PER_RUN = 100;

export interface SchedulerDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly sfn: SFNClient;
  readonly recounterArn: string;
  readonly sqs: SQSClient;
  readonly trackerFailureQueueUrl: string;
  readonly lateGraceMinutes: number;
  readonly recountWindowHours: number;
  readonly metrics: Metrics;
  readonly now?: () => number;
}

export type HourDecision = 'CLOSE' | 'MARK_DIRTY' | 'START' | 'WAIT';

/** What the scheduler does with one hour (pure, spec §4.5). */
export function decide(
  item: HourItem,
  generation: number,
  nowMs: number,
  lateGraceMinutes: number,
  recountWindowHours: number,
): HourDecision {
  if (item.status === 'COUNTED') {
    if (generation > (item.countedGeneration ?? 0)) {
      return 'MARK_DIRTY';
    }
    return nowMs >= closeTimeMs(item.hour, recountWindowHours) ? 'CLOSE' : 'WAIT';
  }
  return takeable(item, nowMs, lateGraceMinutes).take ? 'START' : 'WAIT';
}

export class Scheduler {
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(): Promise<{ started: number; closed: number; replayed: number }> {
    const { db, tableName, metrics, lateGraceMinutes, recountWindowHours } = this.deps;
    // Replay first, and close nothing while a tracked object may still be
    // missing from its hour's generation (spec §4.5).
    const replayed = await this.replayTrackerFailures();
    const mayClose = await this.trackerQueueEmpty();
    const nowMs = this.now();
    const hours = await queryAll<HourItem>(db, {
      TableName: tableName,
      IndexName: PENDING_HOURS_INDEX,
      KeyConditionExpression: 'pending = :p',
      ExpressionAttributeValues: { ':p': PENDING },
    });
    const generations = await this.generations(hours.map((item) => item.hour));

    let started = 0;
    let closed = 0;
    let pastGrace = 0;
    for (const item of hours) {
      const generation = generations.get(item.hour) ?? 0;
      if (item.status !== 'COUNTED' && nowMs >= hourEndMs(item.hour) + lateGraceMinutes * MINUTE_MS) {
        pastGrace++;
      }
      if (item.status !== 'COUNTED' && nowMs >= closeTimeMs(item.hour, recountWindowHours)) {
        metrics.add(METRIC.hourPastCloseNotCounted);
        log.warn('hour past its close is not counted', { hour: item.hour, status: item.status });
      }
      let decision = decide(item, generation, nowMs, lateGraceMinutes, recountWindowHours);
      if (decision === 'CLOSE' && !mayClose) {
        continue;
      }
      if (decision === 'CLOSE') {
        if (await this.close(item)) {
          closed++;
          continue;
        }
        decision = 'MARK_DIRTY';
      }
      if (decision === 'MARK_DIRTY') {
        if (!(await this.markDirty(item))) {
          continue;
        }
        decision = 'START';
      }
      if (decision === 'START' && started < MAX_STARTS_PER_RUN) {
        await this.start(item.hour);
        started++;
      }
    }
    metrics.add(METRIC.hoursPastGrace, pastGrace, {}, true);
    log.info('scheduler ran', { count: hours.length, step: `started=${started} closed=${closed} replayed=${replayed}` });
    return { started, closed, replayed };
  }

  private async generations(hours: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const batch of chunk(hours, 100)) {
      let request: Record<string, { Keys: Array<Record<string, unknown>>; ConsistentRead: boolean }> | undefined = {
        [this.deps.tableName]: { Keys: batch.map((hour) => keys.hourGeneration(hour)), ConsistentRead: true },
      };
      while (request !== undefined && Object.keys(request).length > 0) {
        const result = await withRetry(() => this.deps.db.send(new BatchGetCommand({ RequestItems: request })));
        for (const item of result.Responses?.[this.deps.tableName] ?? []) {
          out.set(String(item.PK).slice('HOUR#'.length), Number(item.generation ?? 0));
        }
        request = result.UnprocessedKeys as typeof request;
      }
    }
    return out;
  }

  /** `COUNTED` → `CLOSED`, if `generation` still equals `countedGeneration`. */
  private async close(item: HourItem): Promise<boolean> {
    const counted = item.countedGeneration ?? 0;
    try {
      await withRetry(() =>
        this.deps.db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.deps.tableName,
                  Key: keys.hourGeneration(item.hour),
                  ConditionExpression: counted === 0 ? 'attribute_not_exists(generation) OR generation = :g' : 'generation = :g',
                  ExpressionAttributeValues: { ':g': counted },
                },
              },
              {
                Update: {
                  TableName: this.deps.tableName,
                  Key: keys.hour(item.hour),
                  UpdateExpression: 'SET #s = :closed REMOVE pending',
                  ConditionExpression: '#s = :counted AND countedGeneration = :g',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':closed': 'CLOSED', ':counted': 'COUNTED', ':g': counted },
                },
              },
            ],
          }),
        ),
      );
      log.info('hour closed', { hour: item.hour });
      return true;
    } catch (error) {
      if (cancellationCodes(error).includes('ConditionalCheckFailed')) {
        return false;
      }
      throw error;
    }
  }

  private async markDirty(item: HourItem): Promise<boolean> {
    try {
      await withRetry(() =>
        this.deps.db.send(
          new UpdateCommand({
            TableName: this.deps.tableName,
            Key: keys.hour(item.hour),
            UpdateExpression: 'SET #s = :dirty',
            ConditionExpression: '#s = :counted AND countedGeneration = :g',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':dirty': 'DIRTY', ':counted': 'COUNTED', ':g': item.countedGeneration ?? 0 },
          }),
        ),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) {
        return false;
      }
      throw error;
    }
  }

  private async start(hour: string): Promise<void> {
    try {
      await this.deps.sfn.send(
        new StartExecutionCommand({
          stateMachineArn: this.deps.recounterArn,
          name: `h${hour}-${ulid(this.now())}`,
          input: JSON.stringify({ hour }),
        }),
      );
    } catch (error) {
      log.error('recount not started', { hour, errorType: errorName(error) });
    }
  }

  private async trackerQueueEmpty(): Promise<boolean> {
    const out = await this.deps.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.deps.trackerFailureQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) === 0;
  }

  /** Replays the S3 events of failed tracker invocations (spec §4.5). */
  private async replayTrackerFailures(): Promise<number> {
    let replayed = 0;
    while (replayed < MAX_REPLAYS_PER_RUN) {
      const out = await this.deps.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: this.deps.trackerFailureQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
      );
      const messages = out.Messages ?? [];
      if (messages.length === 0) {
        break;
      }
      for (const message of messages) {
        try {
          const record = JSON.parse(message.Body ?? '{}') as { requestPayload?: S3Event };
          if (record.requestPayload !== undefined) {
            await trackS3Event(this.deps.db, this.deps.tableName, record.requestPayload, this.deps.metrics);
          }
          await this.deps.sqs.send(
            new DeleteMessageCommand({ QueueUrl: this.deps.trackerFailureQueueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
          replayed++;
        } catch (error) {
          log.error('tracker failure not replayed', { errorType: errorName(error) });
        }
      }
    }
    return replayed;
  }
}
