// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The per-tenant usage key (N-8, M-5, ADR-0011). With `tenantThrottle`, the
 * key factory creates one API key per tenant with this value, and the
 * authoriser computes the same value from the verified `tenant_id` claim and
 * returns it as `usageIdentifierKey`. The value only identifies a tenant for
 * throttling, so it may be derivable: the authoriser then needs no DynamoDB
 * permission, and no row stores it (`apiKeyValue` is a protected name no
 * code may write, spec §7.1).
 *
 * `tei-` + the first 40 hex characters of sha256(stackId + tenantId):
 * 44 characters; API Gateway needs at least 20.
 */

import { createHash } from 'node:crypto';

export function usageKeyValue(stackId: string, tenantId: string): string {
  return `tei-${createHash('sha256').update(stackId + tenantId).digest('hex').slice(0, 40)}`;
}

/** The API key's name, so a retry can find a key it created. */
export function usageKeyName(tenantId: string): string {
  return `tei-${tenantId}`;
}
