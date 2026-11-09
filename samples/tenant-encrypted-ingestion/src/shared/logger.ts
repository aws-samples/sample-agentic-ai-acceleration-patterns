// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structured JSON logs without secrets (M-27, N-6, standard §4.4). Adapted
 * from agentic-runtime-isolation's src/shared/logger.ts (copied, not
 * imported: samples share only constructs and parameters, standard §1.1),
 * with one change that matters here: the field list is an ALLOWLIST. A
 * field not named below is dropped, so a caller cannot put a presigned URL,
 * a signature, a file name, document content or a stream image in a log by
 * passing it under a new name. A string value that looks like a URL or a
 * SigV4 parameter is dropped as well, whatever its field.
 *
 * Every line carries `tenantId` (P-9): the verified tenant, or `-` for a
 * line that is about no tenant (a cold start, a drain). Each record is one
 * JSON line written straight to stdout, so under the Lambda JSON log format
 * its fields stay at the top level (`$.tenantId`), which Contributor
 * Insights rules and Logs Insights queries rely on.
 */

export type LogValue = string | number | boolean | undefined;
export type LogFields = Record<string, LogValue>;

/** The only field names a log line may carry. */
export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'tenantId',
  'deliveryId',
  'operation',
  'step',
  'status',
  'reason',
  'code',
  'validator',
  'verdict',
  'durationMs',
  'sizeBytes',
  'kmsRequests',
  'errorType',
  'httpStatus',
  'keyStatus',
  'tier',
  'receiveCount',
  'eventName',
  'outcome',
  'count',
  'requestId',
  'alarm',
  'backend',
  'scope',
]);

/** A value that could be a URL, a SigV4 query parameter or a header line. */
const UNSAFE_VALUE = /:\/\/|x-amz-|signature|credential|authorization|bearer /i;

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields): void {
  const safe: Record<string, string | number | boolean> = { tenantId: '-' };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !LOG_FIELD_ALLOWLIST.has(key)) {
      continue;
    }
    if (typeof value === 'string' && UNSAFE_VALUE.test(value)) {
      continue;
    }
    safe[key] = value;
  }
  process.stdout.write(JSON.stringify({ level, message, ...safe }) + '\n');
}

export const log = {
  info: (message: string, fields: LogFields = {}) => write('INFO', message, fields),
  warn: (message: string, fields: LogFields = {}) => write('WARN', message, fields),
  error: (message: string, fields: LogFields = {}) => write('ERROR', message, fields),
};

/** The error's class name only: never its message, which may echo input or a URL. */
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return typeof error;
}
