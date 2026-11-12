// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structured JSON logs (P-9, standard §4.4). Callers pass identifiers only:
 * the verified tenantId, the session prefix, the ingress, a status code and
 * the rule that refused a request. Fields whose names look like secrets are
 * dropped before writing, so a mistake in a caller cannot put a token, a
 * credential or a header value in the logs.
 *
 * Each record is one JSON line written straight to stdout, like the EMF
 * records (src/shared/metrics.ts). Under the Lambda JSON log format a
 * `console.log` of a string lands as `{"message": "<the string>"}`, so the
 * fields would not be queryable; a raw stdout line keeps them at the top
 * level (`$.tenantId`), which the demo's Contributor Insights rules and Logs
 * Insights queries rely on (ADR-0021).
 */

export type LogFields = Record<string, string | number | boolean | undefined>;

const FORBIDDEN_FIELD = /token|password|secret|authorization|credential|header|cookie/i;

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, fields: LogFields): void {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FORBIDDEN_FIELD.test(key) && value !== undefined) {
      safe[key] = value;
    }
  }
  process.stdout.write(JSON.stringify({ level, message, ...safe }) + '\n');
}

export const log = {
  info: (message: string, fields: LogFields = {}) => write('INFO', message, fields),
  warn: (message: string, fields: LogFields = {}) => write('WARN', message, fields),
  error: (message: string, fields: LogFields = {}) => write('ERROR', message, fields),
};

/** The error's class name only: never its message, which may echo input. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
