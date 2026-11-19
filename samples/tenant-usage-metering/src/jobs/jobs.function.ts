// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entries of the job workers (spec §4.6), each invoked
 * asynchronously by the admin function with `{ jobId }`:
 *
 * - `handler`: `RECOUNT`, `SINK_REDRIVE`, `RESEND_BLOCKED` (the jobs role);
 * - `readmissionHandler`: `READMIT` (the re-admission role, the only writer of `readmitted/`);
 * - `redriveHandler`: `INGEST_REDRIVE` (the redrive role, which reads the dead-letter queue).
 */

import { FirehoseClient } from '@aws-sdk/client-firehose';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { IngestRedrive } from './ingest-redrive';
import { JOB_BUDGET_MS, JobStore } from './job-store';
import { Jobs } from './jobs';
import { Readmission } from './readmission';
import { s3ObjectStore } from '../recount/recount.function';
import { documentClient } from '../shared/db';
import { ENV, requireEnv, requireIntEnv } from '../shared/env';

interface JobEvent {
  readonly jobId: string;
}

const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function jobIdOf(event: JobEvent): string {
  if (typeof event?.jobId !== 'string' || !JOB_ID.test(event.jobId)) {
    throw new Error('bad job event');
  }
  return event.jobId;
}

function writer(s3: S3Client, bucket: string) {
  return async (key: string, body: string) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
  };
}

export const handler = async (event: JobEvent): Promise<void> => {
  const jobs = new Jobs({
    db: documentClient(),
    tableName: requireEnv(ENV.tableName),
    sqs: new SQSClient({}),
    deliveryQueueUrl: requireEnv(ENV.deliveryQueueUrl),
    recountWindowHours: requireIntEnv(ENV.recountWindowHours),
  });
  const job = await jobs.store.load(jobIdOf(event), ['RECOUNT', 'SINK_REDRIVE', 'RESEND_BLOCKED']);
  if (job === undefined) {
    return;
  }
  await jobs.store.run(
    job,
    (counts, outOfTime) =>
      job.kind === 'RECOUNT' ? jobs.recount(job, counts, outOfTime) : job.kind === 'SINK_REDRIVE' ? jobs.sinkRedrive(job, counts, outOfTime) : jobs.resendBlocked(job, counts, outOfTime),
    JOB_BUDGET_MS,
  );
};

export const readmissionHandler = async (event: JobEvent): Promise<void> => {
  const db = documentClient();
  const tableName = requireEnv(ENV.tableName);
  const s3 = new S3Client({});
  const bucket = requireEnv(ENV.rawBucket);
  const store = new JobStore(db, tableName);
  const job = await store.load(jobIdOf(event), ['READMIT']);
  if (job === undefined) {
    return;
  }
  const readmission = new Readmission({
    db,
    tableName,
    objects: s3ObjectStore(s3, bucket),
    writeObject: writer(s3, bucket),
    recountWindowHours: requireIntEnv(ENV.recountWindowHours),
    store,
  });
  await store.run(job, (counts, outOfTime) => readmission.run(job, counts, outOfTime), JOB_BUDGET_MS);
};

export const redriveHandler = async (event: JobEvent): Promise<void> => {
  const db = documentClient();
  const tableName = requireEnv(ENV.tableName);
  const store = new JobStore(db, tableName);
  const job = await store.load(jobIdOf(event), ['INGEST_REDRIVE']);
  if (job === undefined) {
    return;
  }
  const redrive = new IngestRedrive({
    db,
    tableName,
    sqs: new SQSClient({}),
    queueUrl: requireEnv(ENV.ingestDlqUrl),
    firehose: new FirehoseClient({}),
    streamName: requireEnv(ENV.firehoseStreamName),
    writeObject: writer(new S3Client({}), requireEnv(ENV.rawBucket)),
    recountWindowHours: requireIntEnv(ENV.recountWindowHours),
    store,
  });
  await store.run(job, (counts, outOfTime) => redrive.run(job, counts, outOfTime), JOB_BUDGET_MS);
};
