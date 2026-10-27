// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token verifier (P-3, spec §6.2), shared by both ingresses. It checks
 * the signature against the issuer's JWKS (found through the OIDC discovery
 * document), then `iss`, `exp`, `client_id`, `token_use: access`, a single
 * `tenant_id` and no `tenants` claim, the required scopes (ADR-0005) and the
 * narrowed-token rule (ADR-0007). It returns the claims the ingress may act
 * on and never the raw token.
 *
 * Status mapping (spec §5): 401 for a missing or invalid token; 403 for a
 * valid token the policy refuses (no tenant, missing scope, not narrowed).
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** Why a token was refused; fixed codes, safe to log. */
export type RefusalReason =
  | 'missing_token'
  | 'invalid_token'
  | 'wrong_client'
  | 'not_access_token'
  | 'no_tenant'
  | 'multi_tenant_token'
  | 'scope_missing'
  | 'not_narrowed';

export class TokenError extends Error {
  constructor(readonly status: 401 | 403, readonly reason: RefusalReason) {
    super(reason);
    this.name = 'TokenError';
  }
}

/** Cognito's always-present scope on an un-narrowed token; refused by ADR-0007. */
export const USER_ADMIN_SCOPE = 'aws.cognito.signin.user.admin';

export interface VerifiedClaims {
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
  readonly requireNarrowedToken?: boolean;
  readonly allowedScopes?: string[];
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

export class TokenVerifier {
  private resolved?: Promise<{ issuer: string; getKey: JWTVerifyGetKey }>;

  constructor(private readonly options: VerifierOptions, private readonly deps: VerifierDependencies = {}) {
    if (options.allowedClientIds.length === 0) {
      throw new Error('TokenVerifier: allowedClientIds must not be empty');
    }
    if (options.requireNarrowedToken && (options.allowedScopes === undefined || options.allowedScopes.length === 0)) {
      throw new Error('TokenVerifier: allowedScopes is required with requireNarrowedToken');
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
   * (ADR-0023; jose fetches the JWKS lazily on the first verify otherwise).
   * Resolves when both are fetched or when either failed: a failure is
   * swallowed here (resolve() resets, so the next verify retries) and never
   * surfaces from init.
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

  /** Verifies a raw token (no `Bearer` prefix). Throws TokenError. */
  async verify(token: string | undefined): Promise<VerifiedClaims> {
    if (token === undefined || token.length === 0) {
      throw new TokenError(401, 'missing_token');
    }
    const { issuer, getKey } = await this.resolve();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer, algorithms: ['RS256'] }));
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
    if (payload.tenants !== undefined) {
      throw new TokenError(403, 'multi_tenant_token');
    }
    const tenantId = payload.tenant_id;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new TokenError(403, 'no_tenant');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter((s) => s.length > 0) : [];
    for (const required of this.options.requiredScopes ?? []) {
      if (!scopes.includes(required)) {
        throw new TokenError(403, 'scope_missing');
      }
    }
    if (this.options.requireNarrowedToken) {
      const allowed = this.options.allowedScopes ?? [];
      if (scopes.includes(USER_ADMIN_SCOPE) || scopes.some((s) => !allowed.includes(s))) {
        throw new TokenError(403, 'not_narrowed');
      }
    }
    return { tenantId, sub: payload.sub, clientId, scopes, claims: payload };
  }
}
