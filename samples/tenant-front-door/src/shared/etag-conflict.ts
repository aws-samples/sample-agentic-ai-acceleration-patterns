// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConflictException } from '@aws-sdk/client-cloudfront-keyvaluestore';

/**
 * Whether a KeyValueStore write failed because its `IfMatch` ETag is stale (spec §3.4 step 5, M-15).
 * The store refuses the stale ETag with a conflict (409; 412 is read the same way). The data plane
 * answers a stale ETag as a `ValidationException` (400) whose message says the pre-condition failed:
 * seen live against a real KeyValueStore, so it is a conflict too, not a bad request. The registrar
 * and the route table's custom resource write the same store and use this one test.
 */
export function isEtagConflict(error: unknown): boolean {
  if (error instanceof ConflictException) return true;
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  const status = e?.$metadata?.httpStatusCode;
  if (status === 409 || status === 412) return true;
  return e?.name === 'ValidationException' && /pre-?condition failed/i.test(e.message ?? '');
}
