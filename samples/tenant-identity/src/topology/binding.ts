// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ADR-0027 binding rule. A tenant is reachable only through its own pool:
 * a `pool-per-tenant` tenant through the pool its registry row names, every
 * other tenant through the stack's shared pool. Every path that maps a
 * Cognito pool to a tenant (the trigger's tenant source, the authoriser's
 * issuer) applies it after reading the tenant's row, and refuses on false.
 *
 * It holds trivially in a single-topology deployment, so it is applied in
 * every deployment and nothing branches on the deployment to skip it.
 */

import type { TenantRecord } from '../shared/registry';

/**
 * Where a token or trigger event came from.
 * - `shared`: the stack's shared pool. The authoriser knows the pool id (it
 *   compares `iss` with the shared pool); the trigger knows it from the event
 *   shape (a `custom:tenantId` attribute or `t-*` groups, which only the
 *   shared pool's schema and groups carry).
 * - `pool`: any other pool, by id.
 */
export type ArrivedVia = { readonly kind: 'shared' } | { readonly kind: 'pool'; readonly userPoolId: string };

/** True when `tenant` may be reached through `arrived` (ADR-0027). */
export function bindingHolds(tenant: TenantRecord, arrived: ArrivedVia): boolean {
  if (tenant.topology === 'pool-per-tenant') {
    return arrived.kind === 'pool' && tenant.userPoolId !== undefined && tenant.userPoolId === arrived.userPoolId;
  }
  return arrived.kind === 'shared';
}
