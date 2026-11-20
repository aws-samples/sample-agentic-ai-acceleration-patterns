// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Opaque page tokens: the DynamoDB `LastEvaluatedKey` plus a fingerprint of
 * the query it continues, base64url. A token from another query, or one
 * that does not decode to string keys, is a 400; a token never lets a caller
 * name a key outside the query it was issued for.
 */

import { createHash } from 'node:crypto';
import { apiError } from './errors';

export type PageKey = Record<string, string | number>;

function fingerprint(query: string): string {
  return createHash('sha256').update(query).digest('base64url').slice(0, 16);
}

export function encodeToken(query: string, key: PageKey | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }
  return Buffer.from(JSON.stringify({ q: fingerprint(query), k: key })).toString('base64url');
}

export function decodeToken(query: string, token: string | undefined): PageKey | undefined {
  if (token === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw apiError.validation('nextToken is not valid');
  }
  const value = parsed as { q?: unknown; k?: unknown };
  if (typeof value !== 'object' || value === null || value.q !== fingerprint(query) || typeof value.k !== 'object' || value.k === null) {
    throw apiError.validation('nextToken is not valid for this request');
  }
  const key = value.k as Record<string, unknown>;
  for (const [name, part] of Object.entries(key)) {
    if (!/^[A-Za-z]{1,32}$/.test(name) || (typeof part !== 'string' && typeof part !== 'number')) {
      throw apiError.validation('nextToken is not valid');
    }
  }
  return key as PageKey;
}

export const DEFAULT_PAGE_SIZE = 50;
