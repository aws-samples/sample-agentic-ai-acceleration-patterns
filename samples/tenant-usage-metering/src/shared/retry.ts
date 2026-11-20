// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Jittered backoff for the transient DynamoDB failures every writer of the
 * hour items retries (spec §4.5): a `TransactionConflict` and throttling. A
 * failed condition is a result, not a transient failure, and is never retried
 * here.
 */

const TRANSIENT = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TransactionConflictException',
  'InternalServerError',
  'ServiceUnavailable',
]);

/** Whether a `TransactionCanceledException` was cancelled only by conflicts or throttling. */
export function isTransientCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return false;
  }
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.some((reason) => reason.Code === 'TransactionConflict' || reason.Code === 'ThrottlingError') &&
    reasons.every((reason) => reason.Code === undefined || reason.Code === 'None' || reason.Code === 'TransactionConflict' || reason.Code === 'ThrottlingError');
}

export function isTransient(error: unknown): boolean {
  return error instanceof Error && (TRANSIENT.has(error.name) || isTransientCancellation(error));
}

/** The cancellation codes of a `TransactionCanceledException`, in item order. */
export function cancellationCodes(error: unknown): string[] {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return [];
  }
  return ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => reason.Code ?? 'None');
}

export function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter backoff: a random delay up to `base * 2^attempt`, capped. */
export function backoffMs(attempt: number, baseMs = 50, capMs = 2000): number {
  return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** attempt));
}

export async function withRetry<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt + 1 >= attempts || !isTransient(error)) {
        throw error;
      }
      await sleep(backoffMs(attempt));
    }
  }
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
