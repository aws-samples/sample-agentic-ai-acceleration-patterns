// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant id grammar (spec §7.0, M-13; ADR-0003, ADR-0020: upper case
 * admitted, ids differing only by case are distinct tenants) and the object key layout
 * (spec §4.2, P-7). The grammar is checked wherever a tenant id enters:
 * the authoriser (401), the Smithy path parameter (400) and the processor
 * on the key's second segment (deleted, no event). It keeps `/` out, so
 * `ingest/${tag}/*` never nests one tenant in another, and keeps session
 * names under 64 characters.
 */

import { DOCUMENTS_PREFIX, INGEST_PREFIX, PROBE_SEGMENT } from './constants';

export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,34}$/;

/** A delivery id is a ULID (Crockford base32, 26 characters). */
export const DELIVERY_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value);
}

export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && DELIVERY_ID_PATTERN.test(value);
}

/** `ingest/<tenantId>/<deliveryId>`: no file name in the key (P-7). */
export function dropKey(tenantId: string, deliveryId: string): string {
  return `${INGEST_PREFIX}${tenantId}/${deliveryId}`;
}

/** `documents/<tenantId>/<deliveryId>`. */
export function landedKey(tenantId: string, deliveryId: string): string {
  return `${DOCUMENTS_PREFIX}${tenantId}/${deliveryId}`;
}

/** `ingest/<tenantId>/_probe/<id>`. */
export function probeKey(tenantId: string, id: string): string {
  return `${INGEST_PREFIX}${tenantId}/${PROBE_SEGMENT}/${id}`;
}

/** What an object key under `ingest/` names. */
export type ParsedDropKey =
  | { readonly kind: 'delivery'; readonly tenantId: string; readonly deliveryId: string }
  | { readonly kind: 'probe'; readonly tenantId: string }
  | { readonly kind: 'invalid' };

/**
 * Parses an `Object Created` key (spec §8 step 0, M-15). The tenant id is
 * the second segment and nothing else: object metadata, event detail and
 * the file name are never read for it.
 */
export function parseDropKey(key: string): ParsedDropKey {
  if (!key.startsWith(INGEST_PREFIX)) {
    return { kind: 'invalid' };
  }
  const segments = key.slice(INGEST_PREFIX.length).split('/');
  const tenantId = segments[0];
  if (!isTenantId(tenantId)) {
    return { kind: 'invalid' };
  }
  if (segments.length >= 2 && segments[1] === PROBE_SEGMENT) {
    return { kind: 'probe', tenantId };
  }
  if (segments.length !== 2 || !isDeliveryId(segments[1])) {
    return { kind: 'invalid' };
  }
  return { kind: 'delivery', tenantId, deliveryId: segments[1] };
}

/**
 * The role session name `t-<tenantId>-<suffix>` (spec §7.1, M-13): the
 * suffix is the last 16 characters of the delivery id or an operation
 * name, so S3 access logs, CloudTrail and KMS records name the tenant
 * without a join. At most 2 + 35 + 1 + 16 = 54 characters.
 */
export function sessionName(tenantId: string, suffix: string): string {
  if (!isTenantId(tenantId)) {
    throw new Error('sessionName: tenant id fails the grammar (spec §7.0)');
  }
  const tail = suffix.replace(/[^A-Za-z0-9=,.@-]/g, '-').slice(-16);
  if (tail.length === 0) {
    throw new Error('sessionName: empty suffix');
  }
  return `t-${tenantId}-${tail}`;
}
