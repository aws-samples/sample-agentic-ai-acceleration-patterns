// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Job operations (spec §4.6). A `Start*` call validates its inputs, writes
 * the job `RUNNING` and hands it to its worker asynchronously (202); the
 * worker updates the job's counts and final status.
 */

import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { type AdminContext, type AdminDeps, nowOf, toDate } from './deps';
import { apiError } from './errors';
import { DEFAULT_PAGE_SIZE, decodeToken, encodeToken } from './pagination';
import { getSink } from './sinks';
import { getItem } from '../shared/db';
import type { JobItem, JobKind } from '../shared/items';
import { keys, LIST_BY_TYPE_INDEX } from '../shared/keys';
import { errorName, log } from '../shared/logger';
import { hourSpan, iso, MAX_RANGE_HOURS, pastCloseGuard } from '../shared/time';
import type { JobSummary } from '../smithy/metering/typescript-ssdk-codegen/src';

export function jobOut(item: JobItem): JobSummary {
  return {
    jobId: item.jobId,
    kind: item.kind,
    status: item.status,
    counts: { ...item.counts },
    from: item.from,
    to: item.to,
    reason: item.reason as JobSummary['reason'],
    sinkId: item.sinkId,
    tenantId: item.tenantId,
    applicationId: item.applicationId,
    statusReason: item.statusReason,
    createdBy: item.createdBy,
    createdAt: toDate(item.createdAt),
    updatedAt: toDate(item.updatedAt),
  };
}

/** `from` and `to` inclusive, `from` not after `to`, at most 744 hours apart (spec §4.6). */
export function checkRange(from: string, to: string): void {
  const span = hourSpan(from, to);
  if (span < 0) {
    throw apiError.validation('from must not be after to');
  }
  if (span > MAX_RANGE_HOURS) {
    throw apiError.validation(`from and to are at most ${MAX_RANGE_HOURS} hours apart`);
  }
}

export interface JobInputs {
  readonly from?: string;
  readonly to?: string;
  readonly reason?: string;
  readonly sinkId?: string;
  readonly tenantId?: string;
  readonly applicationId?: string;
}

/** Writes a job `RUNNING` and starts its worker. */
export async function startJob(deps: AdminDeps, ctx: AdminContext, kind: JobKind, inputs: JobInputs): Promise<JobItem> {
  const at = iso(nowOf(deps));
  const jobId = ulid(nowOf(deps));
  const item: JobItem = {
    ...keys.job(jobId),
    SK: 'META',
    jobId,
    kind,
    status: 'RUNNING',
    counts: { processed: 0, admitted: 0, refused: 0, redriven: 0 },
    ...inputs,
    createdBy: ctx.caller.roleArn,
    createdAt: at,
    updatedAt: at,
  };
  await deps.db.send(
    new PutCommand({
      TableName: deps.config.tableName,
      Item: { ...item, listType: 'JOB', listSort: jobId },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  try {
    await deps.startJob(item);
  } catch (error) {
    log.error('job worker not started', { jobId, kind, errorType: errorName(error) });
    await deps.db.send(
      new UpdateCommand({
        TableName: deps.config.tableName,
        Key: keys.job(jobId),
        UpdateExpression: 'SET #s = :failed, statusReason = :why, updatedAt = :at',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':failed': 'FAILED', ':why': 'the worker could not be started', ':at': iso(nowOf(deps)) },
      }),
    );
    throw apiError.internal('the job could not be started');
  }
  return item;
}

export async function startRecount(deps: AdminDeps, ctx: AdminContext, from: string, to: string): Promise<JobItem> {
  checkRange(from, to);
  // An hour closes in order, so the whole range is closed when its last hour is.
  if (pastCloseGuard(to, nowOf(deps), deps.config.recountWindowHours)) {
    throw apiError.conflict('RANGE_CLOSED', 'every hour in the range is closed or within 5 minutes of its close');
  }
  return startJob(deps, ctx, 'RECOUNT', { from, to });
}

export async function startReadmission(
  deps: AdminDeps,
  ctx: AdminContext,
  from: string,
  to: string,
  reason: string | undefined,
): Promise<JobItem> {
  checkRange(from, to);
  return startJob(deps, ctx, 'READMIT', { from, to, reason });
}

export async function startIngestRedrive(deps: AdminDeps, ctx: AdminContext): Promise<JobItem> {
  if (deps.config.ingestPath !== 'BUS') {
    throw apiError.validation('there is no ingest dead-letter queue with ingestPath DIRECT');
  }
  return startJob(deps, ctx, 'INGEST_REDRIVE', {});
}

export async function startSinkRedrive(
  deps: AdminDeps,
  ctx: AdminContext,
  sinkId: string,
  from: string | undefined,
  to: string | undefined,
): Promise<JobItem> {
  if ((from === undefined) !== (to === undefined)) {
    throw apiError.validation('from and to come together or not at all');
  }
  if (from !== undefined && to !== undefined) {
    checkRange(from, to);
  }
  await getSink(deps, sinkId);
  return startJob(deps, ctx, 'SINK_REDRIVE', { sinkId, from, to });
}

export async function startResendBlocked(deps: AdminDeps, ctx: AdminContext, tenantId: string, applicationId: string): Promise<JobItem> {
  return startJob(deps, ctx, 'RESEND_BLOCKED', { tenantId, applicationId });
}

export async function getJob(deps: AdminDeps, jobId: string): Promise<JobItem> {
  const item = await getItem<JobItem>(deps.db, deps.config.tableName, keys.job(jobId), true);
  if (item === undefined) {
    throw apiError.notFound('no such job');
  }
  return item;
}

/** Jobs, newest first. */
export async function listJobs(
  deps: AdminDeps,
  nextToken: string | undefined,
  maxResults: number | undefined,
): Promise<{ jobs: JobItem[]; nextToken?: string }> {
  const query = 'ListJobs';
  const page = await deps.db.send(
    new QueryCommand({
      TableName: deps.config.tableName,
      IndexName: LIST_BY_TYPE_INDEX,
      KeyConditionExpression: 'listType = :t',
      ExpressionAttributeValues: { ':t': 'JOB' },
      ScanIndexForward: false,
      Limit: maxResults ?? DEFAULT_PAGE_SIZE,
      ExclusiveStartKey: decodeToken(query, nextToken),
    }),
  );
  return {
    jobs: (page.Items ?? []) as JobItem[],
    nextToken: encodeToken(query, page.LastEvaluatedKey as Record<string, string> | undefined),
  };
}
