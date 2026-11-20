// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Splits text holding JSON values written back to back, with or without
 * whitespace between them (spec §4.8): Firehose concatenates records with
 * no delimiter, and `readmitted/` objects are newline-delimited. A value
 * that does not parse is reported, not thrown, so one bad record does not
 * hide the rest of the object.
 */

export interface SplitResult {
  readonly values: unknown[];
  readonly malformed: number;
}

export function splitConcatenatedJson(text: string): SplitResult {
  const values: unknown[] = [];
  let malformed = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      if (depth === 0) {
        malformed++;
      }
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          malformed++;
        }
        start = -1;
      } else if (depth < 0) {
        malformed++;
        depth = 0;
      }
    } else if (depth === 0 && !/\s/.test(c)) {
      malformed++;
    }
  }
  if (depth !== 0) {
    malformed++;
  }
  return { values, malformed };
}
