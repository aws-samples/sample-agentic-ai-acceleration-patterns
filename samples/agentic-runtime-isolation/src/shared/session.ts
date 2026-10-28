// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The unit module (spec C-6, P-2, ADR-0002, ADR-0013): the one place that
 * turns validated claims into the isolation unit id. Shared by both ingress
 * Lambdas and by the unit tests, so the hash, the alphabet and the shape are
 * one contract. Nothing here reads a request header or a body: callers pass
 * values they have already validated.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Session scope when the `session` module is on (spec §3.3). */
export type SessionScope = 'user' | 'tenant';

/** RFC 4648 base32 alphabet, lower case, no padding: `[a-z2-7]`. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lower-case base32 of a buffer, no padding (spec §4). */
/* eslint-disable no-bitwise -- bit packing is the algorithm */
export function base32(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}
/* eslint-enable no-bitwise */

/** Length of the claim-derived prefix (spec §4): 26 base32 characters, 130 bits. */
export const PREFIX_LENGTH = 26;

/** `conversationId` shape (spec §4): 16 to 64 of `[A-Za-z0-9]`. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9]{16,64}$/;

/** The claim-derived prefix shape (spec §4). */
export const PREFIX_PATTERN = /^[a-z2-7]{26}$/;

/** The random unit id shape (spec §4): `s-` plus base32 of 32 random bytes. */
export const RANDOM_UNIT_ID_PATTERN = /^s-[a-z2-7]{52}$/;

/**
 * The session prefix (ADR-0002): base32 of sha256 over `tenant_id|sub`
 * (`scope: 'user'`) or over `tenant_id` alone (`scope: 'tenant'`), first 26
 * characters. Both inputs come from the verified token, never the request.
 */
export function sessionPrefix(tenantId: string, sub: string, scope: SessionScope): string {
  if (tenantId.length === 0 || (scope === 'user' && sub.length === 0)) {
    throw new Error('sessionPrefix: tenantId and sub must be non-empty');
  }
  const input = scope === 'tenant' ? tenantId : `${tenantId}|${sub}`;
  return base32(createHash('sha256').update(input, 'utf8').digest()).slice(0, PREFIX_LENGTH);
}

/** True when `value` is a well-formed `conversationId` (spec §4). */
export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

/**
 * The unit id with the `session` module on (spec §4):
 * `s-<prefix>-<conversationId>`. `conversationId` must already be validated;
 * this throws rather than build an id from an unchecked value.
 */
export function sessionUnitId(tenantId: string, sub: string, scope: SessionScope, conversationId: string): string {
  if (!isValidConversationId(conversationId)) {
    throw new Error('sessionUnitId: conversationId is not valid');
  }
  return `s-${sessionPrefix(tenantId, sub, scope)}-${conversationId}`;
}

/**
 * The unit id with the `session` module off (ADR-0013): a fresh random id per
 * request, so no two requests share a unit. 32 random bytes, 52 base32 chars.
 */
export function randomUnitId(random: (size: number) => Uint8Array = randomBytes): string {
  return `s-${base32(random(32))}`;
}

/** The session prefix of a unit id as it appears in logs (never the full id's conversation part). */
export function prefixOf(unitId: string): string {
  return unitId.split('-')[1] ?? '';
}
