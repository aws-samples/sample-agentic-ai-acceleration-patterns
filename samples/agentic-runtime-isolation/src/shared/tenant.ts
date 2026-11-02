// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tenant selection (spec P-3, §5.1, §6.2.1; ADR-0038). An identity token
 * carries exactly one of `tenant_id` (one tenant) or `tenants` (the tenants
 * the user belongs to, accepted only with `identity.multiTenant`). The
 * request names one with `X-Tenant-Id`. The header selects among tenants
 * the verified token already names; it can never add one. From here on
 * every component uses the one selected tenant.
 */

/** The request header that selects one tenant (spec §5.1). */
export const TENANT_HEADER = 'X-Tenant-Id';

/** What a well-formed `X-Tenant-Id` (and a tenant id in a token) looks like at the ingress. */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Why the selection failed; fixed codes, safe to log. */
export type TenantRefusal = 'no_tenant' | 'multi_tenant_token' | 'tenant_required' | 'tenant_not_allowed' | 'malformed_tenant_header';

export class TenantSelectionError extends Error {
  constructor(readonly status: 400 | 403, readonly reason: TenantRefusal) {
    super(reason);
    this.name = 'TenantSelectionError';
  }
}

/** The two tenant claims of a verified token, as they came. */
export interface TenantClaims {
  readonly tenant_id?: unknown;
  readonly tenants?: unknown;
}

/**
 * The one tenant this request acts for. Throws TenantSelectionError:
 *
 * | Case | Status | Reason |
 * |---|---|---|
 * | both claims, or neither | 403 | `tenant_not_allowed` / `no_tenant` |
 * | `tenants` with `multiTenant` off | 403 | `multi_tenant_token` |
 * | a malformed header | 400 | `malformed_tenant_header` |
 * | `tenants` and no header | 400 | `tenant_required` |
 * | header not in `tenants`, or different from `tenant_id` | 403 | `tenant_not_allowed` |
 */
export function selectTenant(claims: TenantClaims, header: string | undefined, multiTenant: boolean): string {
  const single = claims.tenant_id;
  const many = claims.tenants;
  if (single !== undefined && many !== undefined) {
    throw new TenantSelectionError(403, 'tenant_not_allowed');
  }
  if (header !== undefined && !TENANT_ID_PATTERN.test(header)) {
    throw new TenantSelectionError(400, 'malformed_tenant_header');
  }
  if (many !== undefined) {
    if (!multiTenant) {
      throw new TenantSelectionError(403, 'multi_tenant_token');
    }
    if (!Array.isArray(many) || many.length === 0 || many.some((t) => typeof t !== 'string' || !TENANT_ID_PATTERN.test(t))) {
      throw new TenantSelectionError(403, 'no_tenant');
    }
    if (header === undefined) {
      throw new TenantSelectionError(400, 'tenant_required');
    }
    if (!(many as string[]).includes(header)) {
      throw new TenantSelectionError(403, 'tenant_not_allowed');
    }
    return header;
  }
  if (typeof single !== 'string' || single.length === 0) {
    throw new TenantSelectionError(403, 'no_tenant');
  }
  if (header !== undefined && header !== single) {
    throw new TenantSelectionError(403, 'tenant_not_allowed');
  }
  return single;
}
