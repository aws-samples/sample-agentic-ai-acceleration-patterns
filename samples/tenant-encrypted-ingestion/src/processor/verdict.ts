// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The validator verdict schema (spec §3.5, M-21). A verdict is exactly one
 * of:
 *
 *   { "version": "1", "verdict": "ACCEPT" }
 *   { "version": "1", "verdict": "REJECT", "code": "TOO_MANY_PAGES", "message": "412 pages, limit 300" }
 *
 * `code` is `[A-Z0-9_]{1,40}` and required with REJECT; `message` is
 * optional, at most `MAX_MESSAGE_LENGTH` characters. Anything else (a
 * missing or extra field, another version, an ACCEPT carrying a code, a
 * non-object) is schema-invalid, which is a validator error: never ACCEPT.
 */

export const VERDICT_CODE_PATTERN = /^[A-Z0-9_]{1,40}$/;
export const MAX_MESSAGE_LENGTH = 500;

export type Verdict = { readonly verdict: 'ACCEPT' } | { readonly verdict: 'REJECT'; readonly code: string; readonly message?: string };

/** The parsed verdict, or undefined when it is schema-invalid. */
export function parseVerdict(value: unknown): Verdict | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== '1') {
    return undefined;
  }
  const keys = Object.keys(v).sort();
  if (v.verdict === 'ACCEPT') {
    return keys.length === 2 && keys[0] === 'verdict' && keys[1] === 'version' ? { verdict: 'ACCEPT' } : undefined;
  }
  if (v.verdict !== 'REJECT') {
    return undefined;
  }
  const allowed = new Set(['version', 'verdict', 'code', 'message']);
  if (keys.some((k) => !allowed.has(k))) {
    return undefined;
  }
  if (typeof v.code !== 'string' || !VERDICT_CODE_PATTERN.test(v.code)) {
    return undefined;
  }
  if (v.message !== undefined && (typeof v.message !== 'string' || v.message.length > MAX_MESSAGE_LENGTH)) {
    return undefined;
  }
  return { verdict: 'REJECT', code: v.code, ...(typeof v.message === 'string' ? { message: v.message } : {}) };
}
