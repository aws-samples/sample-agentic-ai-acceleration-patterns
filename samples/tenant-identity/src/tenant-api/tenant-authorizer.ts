// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { decomposeUnverifiedJwt } from 'aws-jwt-verify/jwt';
import { isTenantId, POOL_MISMATCH, SCOPE_TENANT_ADMIN, userPoolIdFromIssuer } from '../shared/constants';
import { log } from '../shared/logger';
import type { RegistryReader } from '../shared/registry';
// The binding module only, not the topology barrel: the barrel pulls in the
// provisioners and the Cognito SDK, which this function never calls (R-9).
import { bindingHolds, type ArrivedVia } from '../topology/binding';

/**
 * The core of the tenant authoriser (ADR-0007). It verifies a narrowed admin
 * access token and returns the one thing the tenant-user function may trust:
 * the tenant the token names and the caller's `sub`. Nothing here branches on
 * a topology name: the only distinctions are whether the stack configured a
 * shared pool (shared-pool*, tiered) and whether it creates per-tenant pools
 * (pool-per-tenant, tiered). The decision rules are spec P-2, P-3, P-6, P-11,
 * R-9, the token contract of §6 (P-6) and the ADR-0027 binding rule.
 *
 * Every refusal returns `undefined` and logs the rule name only, never the
 * token or its claims (N-7).
 */

/** The claims the authoriser reads after verification. */
interface AccessTokenClaims {
  readonly token_use?: unknown;
  readonly tenant_id?: unknown;
  readonly tenants?: unknown;
  readonly scope?: unknown;
  readonly sub?: unknown;
}

/** A minimal verifier shape: whatever `CognitoJwtVerifier.create` returns. */
export interface TokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface AuthorizeDeps {
  /** Reads tenant status on every request, uncached (ADR-0007). */
  readonly registry: RegistryReader;
  /** shared-pool*, tiered: the stack's own pool and app client. Absent in pool-per-tenant. */
  readonly sharedPool?: { readonly userPoolId: string; readonly appClientId: string };
  /**
   * ADR-0027: true when the deployment creates a pool per tenant
   * (pool-per-tenant, tiered). Then the token's issuer picks the pool, and an
   * issuer other than the shared pool's is mapped through the registry.
   */
  readonly perTenantPools: boolean;
  /**
   * Returns a verifier for one pool/client, created once and reused: the
   * verifier caches the pool's JWKS for its own lifetime. Caching the
   * verifier per pool id is the caller's job (the handler does it).
   */
  verifierFor(userPoolId: string, clientId: string): TokenVerifier;
}

export interface Caller {
  readonly tenantId: string;
  readonly sub: string;
  /**
   * The tenant's API key value, returned to API Gateway as
   * `usageIdentifierKey` so the stage throttles this tenant on its own
   * (ADR-0025). Never put into the function's context.
   */
  readonly usageIdentifierKey: string;
}

/**
 * Strips a case-insensitive `Bearer ` prefix. Returns `undefined` for a
 * missing header or a non-bearer scheme, so the authoriser refuses it.
 */
export function stripBearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(header.trim());
  return match?.[1];
}

/** Splits a space-separated scope claim into a set; `undefined` is empty. */
function scopeSet(scope: unknown): Set<string> {
  return typeof scope === 'string' ? new Set(scope.split(' ').filter((s) => s !== '')) : new Set<string>();
}

/**
 * Verifies the token and returns the caller, or `undefined` to refuse.
 *
 * Shared pool only (shared-pool*): verify against the stack's pool and client.
 * Per-tenant pools (pool-per-tenant, tiered): read `iss` from the unverified
 * payload only to pick the pool. The shared pool's issuer (tiered) verifies
 * against the shared client; any other issuer is mapped through the
 * registry, then verified with that tenant's pool and app client. The
 * registry is the issuer allowlist for per-tenant pools (§4.1).
 *
 * After a valid signature, the claims must satisfy the token contract (P-6):
 * `token_use` access, a ULID `tenant_id`, no `tenants` claim, `scope`
 * includes `tenant-admin/users`, the tenant exists and is ACTIVE, in
 * pool-per-tenant the registry's tenant for the issuing pool equals
 * `tenant_id`, and the tenant's row is bound to the pool the token came from
 * (ADR-0027 binding rule, refused as `pool_mismatch`).
 */
export async function authorize(token: string, deps: AuthorizeDeps): Promise<Caller | undefined> {
  let userPoolId: string;
  let appClientId: string;
  let expectedTenantId: string | undefined;
  let arrived: ArrivedVia;

  if (!deps.perTenantPools) {
    // shared-pool*: the stack's pool is the only issuer, so nothing is read
    // from the token before verification; the verifier checks `iss` itself.
    if (deps.sharedPool === undefined) {
      // Neither a shared pool nor per-tenant pools: a wiring bug, never an allow.
      log.warn('authorizer refused', { rule: 'no_pool_configured' });
      return undefined;
    }
    userPoolId = deps.sharedPool.userPoolId;
    appClientId = deps.sharedPool.appClientId;
    arrived = { kind: 'shared' };
  } else {
    // pool-per-tenant, tiered: the issuer picks the pool. Decode is unverified
    // and used only to choose which pool's JWKS to verify against.
    let issuer: string | undefined;
    try {
      issuer = decomposeUnverifiedJwt(token).payload.iss;
    } catch {
      log.warn('authorizer refused', { rule: 'malformed_jwt' });
      return undefined;
    }
    const poolId = typeof issuer === 'string' ? userPoolIdFromIssuer(issuer) : undefined;
    if (poolId === undefined) {
      log.warn('authorizer refused', { rule: 'issuer_not_a_pool' });
      return undefined;
    }
    if (deps.sharedPool !== undefined && poolId === deps.sharedPool.userPoolId) {
      // tiered: the shared pool's own issuer, the standard tier's door.
      userPoolId = deps.sharedPool.userPoolId;
      appClientId = deps.sharedPool.appClientId;
      arrived = { kind: 'shared' };
    } else {
      const owner = await deps.registry.getByUserPoolId(poolId);
      if (owner === undefined || owner.appClientId === undefined) {
        log.warn('authorizer refused', { rule: 'pool_not_in_registry' });
        return undefined;
      }
      userPoolId = poolId;
      appClientId = owner.appClientId;
      // The registry's tenant for this pool must equal the token's tenant_id.
      expectedTenantId = owner.tenantId;
      arrived = { kind: 'pool', userPoolId: poolId };
    }
  }

  // Verify the signature, token_use=access, and client_id against the pool.
  let claims: AccessTokenClaims;
  try {
    claims = (await deps.verifierFor(userPoolId, appClientId).verify(token)) as AccessTokenClaims;
  } catch {
    // Wrong signature, wrong pool, wrong app client, expired, wrong token_use.
    log.warn('authorizer refused', { rule: 'verification_failed' });
    return undefined;
  }

  // Defence in depth: the verifier is configured with tokenUse 'access', but
  // check again so a misconfigured verifier cannot admit an ID token.
  if (claims.token_use !== 'access') {
    log.warn('authorizer refused', { rule: 'token_use_not_access' });
    return undefined;
  }

  // An un-narrowed topology-3 token carries `tenants`, never a single
  // `tenant_id`. The admin door only accepts a narrowed token (P-6, ADR-0015).
  if (claims.tenants !== undefined) {
    log.warn('authorizer refused', { rule: 'tenants_claim_present' });
    return undefined;
  }

  const tenantId = claims.tenant_id;
  if (!isTenantId(tenantId)) {
    log.warn('authorizer refused', { rule: 'tenant_id_not_ulid' });
    return undefined;
  }

  if (!scopeSet(claims.scope).has(SCOPE_TENANT_ADMIN)) {
    log.warn('authorizer refused', { rule: 'missing_tenant_admin_scope' });
    return undefined;
  }

  const sub = claims.sub;
  if (typeof sub !== 'string' || sub === '') {
    log.warn('authorizer refused', { rule: 'missing_sub' });
    return undefined;
  }

  // Pool-per-tenant: the registry's tenant for the issuing pool must equal
  // the token's tenant_id, so a token from pool A cannot name tenant B.
  if (expectedTenantId !== undefined && expectedTenantId !== tenantId) {
    log.warn('authorizer refused', { rule: 'issuer_tenant_mismatch' });
    return undefined;
  }

  // Read the tenant's status on every request, uncached: offboarding stops
  // this route at once (P-2, ADR-0007).
  const tenant = await deps.registry.get(tenantId);
  if (tenant === undefined) {
    log.warn('authorizer refused', { rule: 'tenant_absent' });
    return undefined;
  }
  if (tenant.status !== 'ACTIVE') {
    log.warn('authorizer refused', { rule: 'tenant_not_active' });
    return undefined;
  }
  // ADR-0027 binding rule: the tenant's row must name the pool the token came
  // from. A premium (pool-per-tenant) tenant is never reached through the
  // shared pool, and a standard tenant never through a premium pool. Trivially
  // true in a single-topology deployment, checked in every one.
  if (!bindingHolds(tenant, arrived)) {
    log.warn('authorizer refused', { rule: POOL_MISMATCH });
    return undefined;
  }
  // ADR-0025: /tenant/* requires an API key. Without one API Gateway would
  // refuse the call anyway (403); refusing here logs why.
  if (typeof tenant.apiKeyValue !== 'string' || tenant.apiKeyValue === '') {
    log.warn('authorizer refused', { rule: 'tenant_has_no_api_key' });
    return undefined;
  }

  return { tenantId, sub, usageIdentifierKey: tenant.apiKeyValue };
}
