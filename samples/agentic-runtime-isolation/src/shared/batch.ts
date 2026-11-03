// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * DynamoDB batch calls with the retry the service asks for: `BatchGetItem`
 * answers throttled keys in `UnprocessedKeys` and `BatchWriteItem` throttled
 * writes in `UnprocessedItems`, without an error. Both are resent with
 * exponential backoff and full jitter until nothing is left or the attempts
 * run out; then the call throws `UnprocessedError`, so a caller never reads
 * a throttled key as "absent" (spec §3.6: an unread cut row would grant the
 * user the full tenant set).
 */

import { BatchGetCommand, type BatchGetCommandInput, BatchWriteCommand, type BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';

/** What the batch helpers need from a document client. */
export interface BatchClient {
  send(command: BatchGetCommand | BatchWriteCommand): Promise<unknown>;
}

export interface RetryOptions {
  /** Calls in all, the first included. Default 4. */
  readonly maxAttempts?: number;
  /** Base delay in ms; attempt n waits up to base * 2^n (full jitter). Default 25. */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Thrown when keys or writes are still unprocessed after the last attempt. */
export class UnprocessedError extends Error {
  constructor(readonly operation: 'BatchGetItem' | 'BatchWriteItem', readonly remaining: number) {
    super(`${operation}: ${remaining} unprocessed after retries`);
    this.name = 'UnprocessedError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function delay(attempt: number, options: RetryOptions): number {
  const base = options.baseDelayMs ?? 25;
  return Math.floor((options.random ?? Math.random)() * base * 2 ** attempt);
}

type GetRequest = NonNullable<BatchGetCommandInput['RequestItems']>;
type WriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>;

function countKeys(request: GetRequest | undefined): number {
  return Object.values(request ?? {}).reduce((n, r) => n + (r.Keys?.length ?? 0), 0);
}

function countWrites(request: WriteRequest | undefined): number {
  return Object.values(request ?? {}).reduce((n, r) => n + (r?.length ?? 0), 0);
}

/**
 * `BatchGetItem` until every key is processed. Returns the items per table,
 * merged across attempts. Throws `UnprocessedError` when keys remain.
 */
export async function batchGetAll(
  client: BatchClient,
  requestItems: GetRequest,
  options: RetryOptions = {},
): Promise<Record<string, Record<string, unknown>[]>> {
  const responses: Record<string, Record<string, unknown>[]> = {};
  let pending: GetRequest | undefined = requestItems;
  const attempts = options.maxAttempts ?? 4;
  for (let attempt = 0; attempt < attempts && countKeys(pending) > 0; attempt++) {
    if (attempt > 0) {
      await (options.sleep ?? defaultSleep)(delay(attempt, options));
    }
    const out = (await client.send(new BatchGetCommand({ RequestItems: pending }))) as {
      Responses?: Record<string, Record<string, unknown>[]>;
      UnprocessedKeys?: GetRequest;
    };
    for (const [table, items] of Object.entries(out.Responses ?? {})) {
      (responses[table] ??= []).push(...items);
    }
    pending = out.UnprocessedKeys;
  }
  const left = countKeys(pending);
  if (left > 0) {
    throw new UnprocessedError('BatchGetItem', left);
  }
  return responses;
}

/** `BatchWriteItem` until every write is processed. Throws `UnprocessedError` when writes remain. */
export async function batchWriteAll(client: BatchClient, requestItems: WriteRequest, options: RetryOptions = {}): Promise<void> {
  let pending: WriteRequest | undefined = requestItems;
  const attempts = options.maxAttempts ?? 4;
  for (let attempt = 0; attempt < attempts && countWrites(pending) > 0; attempt++) {
    if (attempt > 0) {
      await (options.sleep ?? defaultSleep)(delay(attempt, options));
    }
    const out = (await client.send(new BatchWriteCommand({ RequestItems: pending }))) as { UnprocessedItems?: WriteRequest };
    pending = out.UnprocessedItems;
  }
  const left = countWrites(pending);
  if (left > 0) {
    throw new UnprocessedError('BatchWriteItem', left);
  }
}
