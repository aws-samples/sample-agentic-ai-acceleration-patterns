// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What every job worker shares (spec §4.6): reading its job, writing its
 * counts as it goes, and its final status. A worker runs inside one Lambda
 * invocation and stops at a time budget below the function timeout; a job
 * that ran out of time is `FAILED` with that reason and can be started
 * again, because every job is safe to repeat.
 */

import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getItem } from '../shared/db';
import type { JobCounts, JobItem, JobKind } from '../shared/items';
import { keys } from '../shared/keys';
import { errorName, log } from '../shared/logger';
import { withRetry } from '../shared/retry';
import { iso } from '../shared/time';

export class JobStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(jobId: string, kinds: ReadonlyArray<JobKind>): Promise<JobItem | undefined> {
    const job = await getItem<JobItem>(this.db, this.tableName, keys.job(jobId), true);
    if (job === undefined || job.status !== 'RUNNING' || !kinds.includes(job.kind)) {
      log.warn('job not runnable here', { jobId, kind: job?.kind, status: job?.status });
      return undefined;
    }
    return job;
  }

  async progress(job: JobItem, counts: JobCounts): Promise<void> {
    await withRetry(() =>
      this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.job(job.jobId),
          UpdateExpression: 'SET #c = :c, updatedAt = :at',
          ConditionExpression: '#s = :running',
          ExpressionAttributeNames: { '#c': 'counts', '#s': 'status' },
          ExpressionAttributeValues: { ':c': counts, ':at': iso(this.now()), ':running': 'RUNNING' },
        }),
      ),
    );
  }

  async finish(job: JobItem, counts: JobCounts, failure?: string): Promise<void> {
    await withRetry(() =>
      this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.job(job.jobId),
          UpdateExpression: failure === undefined ? 'SET #c = :c, updatedAt = :at, #s = :done' : 'SET #c = :c, updatedAt = :at, #s = :done, statusReason = :why',
          ConditionExpression: '#s = :running',
          ExpressionAttributeNames: { '#c': 'counts', '#s': 'status' },
          ExpressionAttributeValues: {
            ':c': counts,
            ':at': iso(this.now()),
            ':running': 'RUNNING',
            ':done': failure === undefined ? 'SUCCEEDED' : 'FAILED',
            ...(failure === undefined ? {} : { ':why': failure }),
          },
        }),
      ),
    );
    log.info('job finished', { jobId: job.jobId, kind: job.kind, status: failure === undefined ? 'SUCCEEDED' : 'FAILED', count: counts.processed });
  }

  /** Runs a job body with its counts; any throw or a spent budget ends the job `FAILED`. */
  async run(job: JobItem, body: (counts: JobCounts, outOfTime: () => boolean) => Promise<void>, budgetMs: number): Promise<void> {
    const counts: JobCounts = { processed: 0, admitted: 0, refused: 0, redriven: 0 };
    const deadline = this.now() + budgetMs;
    let timedOut = false;
    const outOfTime = () => {
      timedOut = timedOut || this.now() >= deadline;
      return timedOut;
    };
    try {
      await body(counts, outOfTime);
      await this.finish(job, counts, timedOut ? 'ran out of time; start the job again to continue' : undefined);
    } catch (error) {
      log.error('job failed', { jobId: job.jobId, kind: job.kind, errorType: errorName(error) });
      await this.finish(job, counts, `failed: ${errorName(error)}`);
    }
  }
}

/** Workers stop here, below their 15-minute function timeout. */
export const JOB_BUDGET_MS = 13 * 60 * 1000;
