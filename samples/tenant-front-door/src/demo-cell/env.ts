// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The demo cell API function's environment variable names: `DemoCellApi` sets them, the handler reads them. */
export const CELL_API_ENV = {
  /** The issuer's `iss`. */
  issuer: 'ISSUER',
  /** The issuer's JWKS URL. */
  jwksUrl: 'JWKS_URL',
  /** Comma-separated app client ids. */
  allowedClientIds: 'ALLOWED_CLIENT_IDS',
  /** The `tenantClaim` input (§3.6). */
  tenantClaim: 'TENANT_CLAIM',
  applicationId: 'APPLICATION_ID',
  cellId: 'CELL_ID',
  /** The per-tenant rate table; unset when the limit is off. */
  limitTable: 'LIMIT_TABLE',
  /** `tenantRequestsPer5Min`; `0` turns the origin limit off. */
  tenantRequestsPer5Min: 'TENANT_REQUESTS_PER_5MIN',
} as const;
