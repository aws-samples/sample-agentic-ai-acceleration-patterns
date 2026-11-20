// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `INGEST_REDRIVE` (spec §3.1, §6.2 item 8): moves the ingest subscriber's
 * dead-letter messages into Firehose, each as the envelope the bus would
 * have delivered, unchanged, so the recount reads it like any other.
 * Before each put the close guard runs on the event's hour: an event whose
 * hour is closed or within 60 minutes of its close goes to `error/` as
 * `TOO_LATE` and its message is deleted (spec §4.5).
 */

import type { FirehoseClient } from '@aws-sdk/client-firehose';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { JobStore } from './job-store';
import { putFirehoseRecords } from '../ingest/publish';
import { asEnrichedEvent } from '../recount/stored-events';
import { getItem } from '../shared/db';
import type { HourItem, JobCounts, JobItem } from '../shared/items';
import { keys } from '../shared/keys';
import { log } from '../shared/logger';
import { iso, pastCloseGuard } from '../shared/time';
import { hourOf } from '../shared/usage-event';

export interface RedriveDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly firehose: FirehoseClient;
  readonly streamName: string;
  readonly writeObject: (key: string, body: string) => Promise<void>;
  readonly recountWindowHours: number;
  readonly store: JobStore;
  readonly now?: () => number;
}

export class IngestRedrive {
  private readonly now: () => number;

  constructor(private readonly deps: RedriveDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async hourClosed(hour: string): Promise<boolean> {
    if (pastCloseGuard(hour, this.now(), this.deps.recountWindowHours)) {
      return true;
    }
    return (await getItem<HourItem>(this.deps.db, this.deps.tableName, keys.hour(hour), true))?.status === 'CLOSED';
  }

  async run(job: JobItem, counts: JobCounts, outOfTime: () => boolean): Promise<void> {
    const { sqs, queueUrl } = this.deps;
    while (!outOfTime()) {
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 120 }),
      );
      const messages = out.Messages ?? [];
      if (messages.length === 0) {
        return;
      }
      const toPut: Array<{ body: string; receipt: string }> = [];
      const done: string[] = [];
      const tooLate: unknown[] = [];
      for (const message of messages) {
        counts.processed++;
        const body = message.Body ?? '';
        let envelope: { detail?: unknown } | undefined;
        try {
          envelope = JSON.parse(body) as { detail?: unknown };
        } catch {
          envelope = undefined;
        }
        const event = asEnrichedEvent(envelope?.detail);
        if (event === undefined) {
          // Not an ingest envelope: left on the queue for an operator to look at.
          log.warn('dead-letter message is not an ingest envelope', { jobId: job.jobId });
          counts.refused++;
          continue;
        }
        if (await this.hourClosed(hourOf(event.time))) {
          tooLate.push(event);
          done.push(message.ReceiptHandle!);
          counts.refused++;
          continue;
        }
        toPut.push({ body, receipt: message.ReceiptHandle! });
      }
      if (tooLate.length > 0) {
        const nowMs = this.now();
        await this.deps.writeObject(
          `error/hour=${hourOf(new Date(nowMs))}/${iso(nowMs).replace(/[-:.]/g, '')}-${job.jobId}-redrive.json`,
          JSON.stringify({
            receivedAt: iso(nowMs),
            requestId: job.jobId,
            events: tooLate.map((event, index) => ({ index, reason: 'TOO_LATE', event })),
          }),
        );
      }
      const stored = await putFirehoseRecords(
        this.deps.firehose,
        this.deps.streamName,
        toPut.map((item) => Buffer.from(item.body)),
      );
      toPut.forEach((item, i) => {
        if (stored.has(i)) {
          done.push(item.receipt);
          counts.redriven++;
        }
      });
      if (done.length > 0) {
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: done.map((receipt, i) => ({ Id: String(i), ReceiptHandle: receipt })),
          }),
        );
      }
      await this.deps.store.progress(job, counts);
      if (toPut.length > stored.size) {
        throw new Error('Firehose refused records; start the job again');
      }
    }
  }
}
