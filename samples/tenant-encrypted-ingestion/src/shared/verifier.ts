// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token verifier (spec §3.2, §7.0, M-1; ADR-0011). Adapted from
 * agentic-runtime-isolation's src/shared/verifier.ts (copied, not imported,
 * standard §1.1): the signature against the issuer's JWKS (found through the
 * OIDC discovery document), then `iss`, `exp`, `client_id` in the allowlist,
 * `token_use: access`, a non-empty `sub`, no `tenants` claim and one string
 * `tenant_id` matching the §7.0 grammar. Unlike the source, every refusal
 * here is the same 401 (M-1): the authoriser has one answer for a token it
 * will not admit, and the handler, not the authoriser, checks scopes per
 * route (M-2), because the authoriser result is cached per token for up to
 * 300 s across every `/tenant/*` route.
 *
 * It returns the claims the authoriser passes on and never the raw token.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { isTenantId } from './tenant-id';

/** Why a token was refused; fixed codes, safe to log. */
export type RefusalReason =
  | 'missing_token'
  | 'invalid_token'
  | 'wrong_client'
  | 'not_access_token'
  | 'no_subject'
  | 'multi_tenant_token'
  | 'no_tenant'
  | 'bad_tenant_id';

export class TokenError extends Error {
  readonly status = 401;
  constructor(readonly reason: RefusalReason) {
    super(reason);
    this.name = 'TokenError';
  }
}

export interface VerifiedClaims {
  readonly tenantId: string;
  readonly sub: string;
  readonly clientId: string;
  readonly scopes: string[];
}

export interface VerifierOptions {
  readonly discoveryUrl: string;
  readonly allowedClientIds: string[];
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

  /** Verifies a raw token (no `Bearer` prefix). Throws TokenError. */
  async verify(token: string | undefined): Promise<VerifiedClaims> {
    if (token === undefined || token.length === 0) {
      throw new TokenError('missing_token');
    }
    const { issuer, getKey } = await this.resolve();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer, algorithms: ['RS256'] }));
    } catch {
      throw new TokenError('invalid_token');
    }
    const clientId = payload.client_id;
    if (typeof clientId !== 'string' || !this.options.allowedClientIds.includes(clientId)) {
      throw new TokenError('wrong_client');
    }
    if (payload.token_use !== 'access') {
      throw new TokenError('not_access_token');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new TokenError('no_subject');
    }
    if (payload.tenants !== undefined) {
      throw new TokenError('multi_tenant_token');
    }
    const tenantId = payload.tenant_id;
    if (tenantId === undefined) {
      throw new TokenError('no_tenant');
    }
    if (!isTenantId(tenantId)) {
      throw new TokenError('bad_tenant_id');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter((s) => s.length > 0) : [];
    return { tenantId, sub: payload.sub, clientId, scopes };
  }
}
