// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Structured JSON logs (P-9, standard §4.4). Callers pass identifiers only:
 * the verified tenantId, the session prefix, the ingress, a status code and
 * the rule that refused a request. Fields whose names look like secrets are
 * dropped before writing, so a mistake in a caller cannot put a token, a
 * credential or a header value in the logs.
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
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, message, ...safe }));
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
