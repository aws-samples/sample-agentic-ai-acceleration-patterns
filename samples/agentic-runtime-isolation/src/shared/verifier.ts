// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The identity-token verifier (P-3, spec §6.2.1), shared by both ingresses
 * and by the tenant-admin side of the entitlement API. It refuses a
 * transaction token presented as an identity token (header `typ: txn+jwt`,
 * or `iss` = this ingress's own issuer; P-14, ADR-0031) before any key is
 * fetched, then checks the signature against the issuer's JWKS (found
 * through the OIDC discovery document), `iss`, `exp`, `client_id`,
 * `token_use: access`, selects the one tenant the request acts for
 * (`tenant_id`, or `tenants` plus `X-Tenant-Id`; ADR-0038), and the floor
 * scopes (ADR-0005). It returns the claims the ingress may act on and never
 * the raw token.
 *
 * Status mapping (spec §5.1): 401 for a missing or invalid token (including
 * a transaction token); 400 for `tenant_required` or a malformed tenant
 * header; 403 for a valid token the policy refuses.
 */

import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { TRANSACTION_TOKEN_TYPE } from './mint';
import { selectTenant, TenantSelectionError, type TenantRefusal } from './tenant';

/** Why a token was refused; fixed codes, safe to log. */
export type RefusalReason =
  | 'missing_token'
  | 'invalid_token'
  | 'transaction_token'
  | 'wrong_client'
  | 'not_access_token'
  | 'scope_missing'
  | TenantRefusal;

export class TokenError extends Error {
  constructor(readonly status: 400 | 401 | 403, readonly reason: RefusalReason) {
    super(reason);
    this.name = 'TokenError';
  }
}

export interface VerifiedClaims {
  /** The one tenant this request acts for, selected under P-3. */
  readonly tenantId: string;
  readonly sub: string;
  readonly clientId: string;
  readonly scopes: string[];
  /** Every claim of the verified token, for `tvm.claimTags` lookups. */
  readonly claims: JWTPayload;
}

export interface VerifierOptions {
  readonly discoveryUrl: string;
  readonly allowedClientIds: string[];
  readonly requiredScopes?: string[];
  /** Accept tokens that carry `tenants` (ADR-0038). Default false. */
  readonly multiTenant?: boolean;
  /** This ingress's own issuer (the transaction-token `iss`): a token from it is refused (P-14). */
  readonly ownIssuer?: string;
}

/** The two fields the verifier needs from the OIDC discovery document. */
export interface Discovery {
  readonly issuer: string;
  readonly jwksUri: string;
}

/** Injection points for tests: a local JWKS and a canned discovery document. */
export interface VerifierDependencies {
  readonly getKey?: JWTVerifyGetKey;
  readonly fetchDiscovery?: (discoveryUrl: string) => Promise<Discovery>;
}

/** The token from an `Authorization: Bearer <token>` value, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

async function fetchDiscoveryDocument(discoveryUrl: string): Promise<Discovery> {
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with HTTP ${response.status}`);
  }
  const doc = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (typeof doc.issuer !== 'string' || typeof doc.jwks_uri !== 'string') {
    throw new Error('OIDC discovery document lacks issuer or jwks_uri');
  }
  return { issuer: doc.issuer, jwksUri: doc.jwks_uri };
}

/**
 * Whether an unverified token is one of this ingress's own transaction
 * tokens (P-14): `typ: txn+jwt`, or `iss` equal to `ownIssuer`. A token that
 * does not decode is not one (the signature check refuses it next).
 */
export function isTransactionToken(token: string, ownIssuer: string | undefined): boolean {
  try {
    if (decodeProtectedHeader(token).typ === TRANSACTION_TOKEN_TYPE) {
      return true;
    }
    return ownIssuer !== undefined && decodeJwt(token).iss === ownIssuer;
  } catch {
    return false;
  }
}

export class TokenVerifier {
  private resolved?: Promise<{ issuer: string; getKey: JWTVerifyGetKey }>;

  constructor(private readonly options: VerifierOptions, private readonly deps: VerifierDependencies = {}) {
    if (options.allowedClientIds.length === 0) {
      throw new Error('TokenVerifier: allowedClientIds must not be empty');
    }
  }

  private resolve(): Promise<{ issuer: string; getKey: JWTVerifyGetKey }> {
    if (this.resolved === undefined) {
      const fetchDiscovery = this.deps.fetchDiscovery ?? fetchDiscoveryDocument;
      this.resolved = fetchDiscovery(this.options.discoveryUrl).then((d) => ({
        issuer: d.issuer,
        getKey: this.deps.getKey ?? createRemoteJWKSet(new URL(d.jwksUri)),
      }));
      // A failed discovery must not poison the container: retry next request.
      this.resolved.catch(() => {
        this.resolved = undefined;
      });
    }
    return this.resolved;
  }

  /**
   * Fetches the discovery document and then the JWKS now, so a container
   * that calls this at init has both in hand for its first request
   * (ADR-0023). A failure is swallowed (the next verify retries).
   */
  async warm(): Promise<void> {
    try {
      const { getKey } = await this.resolve();
      const remote = getKey as JWTVerifyGetKey & { reload?: () => Promise<void> };
      await remote.reload?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Verifies a raw identity token (no `Bearer` prefix) and selects the
   * tenant with `tenantHeader` (the `X-Tenant-Id` value, if any). Throws
   * TokenError.
   */
  async verify(token: string | undefined, tenantHeader?: string): Promise<VerifiedClaims> {
    if (token === undefined || token.length === 0) {
      throw new TokenError(401, 'missing_token');
    }
    // P-14: the ingress never accepts its own transaction token as an
    // identity token. Checked before the issuer's keys are consulted.
    if (isTransactionToken(token, this.options.ownIssuer)) {
      throw new TokenError(401, 'transaction_token');
    }
    const { issuer, getKey } = await this.resolve();
    let payload: JWTPayload;
    try {
      // A token without `exp` or `iat` never verifies: jose checks `exp` only when present.
      ({ payload } = await jwtVerify(token, getKey, { issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'iat'] }));
    } catch {
      throw new TokenError(401, 'invalid_token');
    }
    const clientId = payload.client_id;
    if (typeof clientId !== 'string' || !this.options.allowedClientIds.includes(clientId)) {
      throw new TokenError(401, 'wrong_client');
    }
    if (payload.token_use !== 'access') {
      throw new TokenError(401, 'not_access_token');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new TokenError(401, 'invalid_token');
    }
    let tenantId: string;
    try {
      tenantId = selectTenant({ tenant_id: payload.tenant_id, tenants: payload.tenants }, tenantHeader, this.options.multiTenant ?? false);
    } catch (error) {
      if (error instanceof TenantSelectionError) {
        throw new TokenError(error.status, error.reason);
      }
      throw error;
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter((s) => s.length > 0) : [];
    for (const required of this.options.requiredScopes ?? []) {
      if (!scopes.includes(required)) {
        throw new TokenError(403, 'scope_missing');
      }
    }
    return { tenantId, sub: payload.sub, clientId, scopes, claims: payload };
  }
}
