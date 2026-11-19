// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The demo cell API's token check (spec §3.5, §6.1, ADR-0005, ADR-0011).
 * The token comes from `x-tenant-token`, which the router copies from
 * `Authorization` because origin access control overwrites that header.
 * It is verified against the issuer's JWKS and checked against the token
 * contract (`ARCHITECTURE.md` §2.1): `iss`, `exp`, the client in the
 * allowlist (`client_id`, or `aud` for an issuer that emits none), an
 * access-token mark (`token_use: access`, or the header `typ: at+jwt`),
 * a non-empty `sub`, no `tenants` claim, and one string tenant claim named
 * by `tenantClaim` (§3.6) that is a valid route id once lower-cased (§4.1).
 *
 * It returns the tenant in its control-plane form (upper case) and never
 * the raw token, so nothing downstream can log it.
 */

import { createRemoteJWKSet, jwtVerify, type JWTHeaderParameters, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { MULTI_TENANT_CLAIM } from '../shared/contracts';
import { toStoredId } from '../shared/route-table';

/** Why a token was refused; fixed codes, safe to log. */
export type TokenRefusal =
  | 'missing_token'
  | 'expired_token'
  | 'invalid_token'
  | 'wrong_client'
  | 'not_access_token'
  | 'no_subject'
  | 'multi_tenant_token'
  | 'no_tenant'
  | 'bad_tenant_id';

export class TokenError extends Error {
  constructor(readonly reason: TokenRefusal) {
    super(reason);
    this.name = 'TokenError';
  }
}

/** The issuer's keys could not be fetched or parsed: not the caller's fault, so the cell answers 503, not 403. */
export class IssuerUnavailableError extends Error {
  constructor(cause: unknown) {
    super('issuer keys unavailable', { cause });
    this.name = 'IssuerUnavailableError';
  }
}

/** jose error codes that mean the key set, not the token, failed. Codes, not classes, so the check holds across module copies. */
const ISSUER_FAILURE_CODES = new Set(['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

export interface VerifiedToken {
  /** The verified tenant claim in its control-plane form (upper case). */
  readonly tenantId: string;
}

export interface TokenVerifierOptions {
  /** The issuer's `iss` value. */
  readonly issuer: string;
  /** The issuer's JWKS URL. */
  readonly jwksUrl: string;
  /** App clients whose tokens the cell accepts. */
  readonly allowedClientIds: readonly string[];
  /** The claim that names the tenant (§3.6). */
  readonly tenantClaim: string;
}

export interface TokenVerifierDependencies {
  /** Tests pass a local key set; the default fetches and caches the issuer's JWKS. */
  readonly getKey?: JWTVerifyGetKey;
}

/** Largest token the cell will parse; the router refuses an `Authorization` header over 8,192 bytes (§3.3 step 5). */
const MAX_TOKEN_LENGTH = 8192;

export class TokenVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(private readonly options: TokenVerifierOptions, deps: TokenVerifierDependencies = {}) {
    if (options.allowedClientIds.length === 0) {
      throw new Error('TokenVerifier: allowedClientIds must not be empty');
    }
    // createRemoteJWKSet caches the keys per container and refetches on an
    // unknown `kid`, at most once per cooldown (jose defaults: 30 s cooldown,
    // 10 min max age).
    this.getKey = deps.getKey ?? createRemoteJWKSet(new URL(options.jwksUrl));
  }

  /** Verifies a raw token (no `Bearer` prefix). Throws TokenError. */
  async verify(token: string | undefined): Promise<VerifiedToken> {
    if (token === undefined || token.length === 0) {
      throw new TokenError('missing_token');
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new TokenError('invalid_token');
    }
    let payload: JWTPayload;
    let protectedHeader: JWTHeaderParameters;
    try {
      const verifyOptions = { issuer: this.options.issuer, algorithms: ['RS256'], requiredClaims: ['exp'] };
      ({ payload, protectedHeader } = await jwtVerify(token, this.getKey, verifyOptions));
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || ISSUER_FAILURE_CODES.has(code)) {
        // A network error from the JWKS fetch has no jose code.
        throw new IssuerUnavailableError(error);
      }
      // jose checks the signature before the claims, so an expired token here is authentic.
      throw new TokenError(code === 'ERR_JWT_EXPIRED' ? 'expired_token' : 'invalid_token');
    }
    if (!this.clientAllowed(payload)) {
      throw new TokenError('wrong_client');
    }
    if (!isAccessToken(payload, protectedHeader.typ)) {
      throw new TokenError('not_access_token');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new TokenError('no_subject');
    }
    if (payload[MULTI_TENANT_CLAIM] !== undefined) {
      throw new TokenError('multi_tenant_token');
    }
    const claim = payload[this.options.tenantClaim];
    if (claim === undefined) {
      throw new TokenError('no_tenant');
    }
    if (typeof claim !== 'string') {
      throw new TokenError('bad_tenant_id');
    }
    try {
      return { tenantId: toStoredId(claim).toUpperCase() };
    } catch {
      throw new TokenError('bad_tenant_id');
    }
  }

  /**
   * Cognito's `client_id` when present (it decides alone, so an `aud`
   * naming a resource server is not mistaken for a client), else any `aud`
   * value in the allowlist.
   */
  private clientAllowed(payload: JWTPayload): boolean {
    const allowed = this.options.allowedClientIds;
    if (payload.client_id !== undefined) {
      return typeof payload.client_id === 'string' && allowed.includes(payload.client_id);
    }
    const aud = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    return aud.some((a) => typeof a === 'string' && allowed.includes(a));
  }
}

/** `token_use: access` (Cognito), else the RFC 9068 header `typ: at+jwt`. An ID token carries neither. */
function isAccessToken(payload: JWTPayload, typ: string | undefined): boolean {
  if (payload.token_use !== undefined) {
    return payload.token_use === 'access';
  }
  const t = typ?.toLowerCase();
  return t === 'at+jwt' || t === 'application/at+jwt';
}
