// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of `runCodeFunction`, the standalone entry (spec §3.2,
 * ADR-0017). The vendor's own API invokes it with IAM and passes the
 * `tenantId` it verified with its own identity provider; this function
 * trusts that field, so who may invoke it is the vendor's to limit
 * (threat T-82). The gateway entry is `src/gateway/`, which calls the same
 * `runCode` with the tenant from the signed context.
 *
 * It returns the output, or `{ error, retryAfterSeconds? }`: a tool error is
 * a value, not a Lambda error, so the caller sees the code (spec §5.1).
 */

import type { Context } from 'aws-lambda';
import { runCode } from './run-code';
import type { RunCodeRequest, RunCodeResult } from './types';

export async function handler(event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<RunCodeResult> {
  return runCode(event as RunCodeRequest, undefined, { remainingMs: context === undefined ? undefined : () => context.getRemainingTimeInMillis() });
}
