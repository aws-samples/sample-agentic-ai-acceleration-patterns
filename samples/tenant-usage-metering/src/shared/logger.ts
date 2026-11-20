// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structured JSON logs with an allowlist of fields (spec §3.5, Logs):
 * no event payload, sink request or response body, or credential is
 * logged. A field not named below is dropped, and a string value that looks
 * like a URL, a header or a SigV4 parameter is dropped whatever its field.
 * Each line is written straight to stdout, so under the Lambda JSON log
 * format its fields stay at the top level.
 */

export type LogValue = string | number | boolean | undefined;
export type LogFields = Record<string, LogValue>;

export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'operation',
  'requestId',
  'caller',
  'tenantId',
  'applicationId',
  'emitterId',
  'meterId',
  'sinkId',
  'jobId',
  'kind',
  'hour',
  'status',
  'reason',
  'count',
  'accepted',
  'refused',
  'retry',
  'errorType',
  'httpStatus',
  'durationMs',
  'attempt',
  'generation',
  'step',
]);

const UNSAFE_VALUE = /:\/\/|x-amz-|signature|credential|authorization|bearer /i;

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields): void {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !LOG_FIELD_ALLOWLIST.has(key)) {
      continue;
    }
    if (typeof value === 'string' && UNSAFE_VALUE.test(value)) {
      continue;
    }
    safe[key] = value;
  }
  process.stdout.write(`${JSON.stringify({ level, message, ...safe, timestamp: new Date().toISOString() })}\n`);
}

export const log = {
  info: (message: string, fields: LogFields = {}) => write('INFO', message, fields),
  warn: (message: string, fields: LogFields = {}) => write('WARN', message, fields),
  error: (message: string, fields: LogFields = {}) => write('ERROR', message, fields),
};

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
