// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The caller side of a delegation (spec §3.7, §5.1.1; ADR-0048). On
 * `POST /{backend}/delegations` the bearer is a transaction token this
 * ingress minted for the calling agent. This module verifies it against the
 * ingress's own JWKS and returns what the replacement token is built from:
 * the tenant and user (copied), the calling agent, the `act` chain (nested
 * under the caller) and the `txn` (copied).
 *
 * The checks are the ones the spec names: `iss` = the ingress issuer,
 * `typ: txn+jwt`, `aud` holds `agent:<agent>`, the innermost `act.sub` is
 * the ingress role, and more than DELEGATION_EXP_MARGIN_SECONDS of life is
 * left (the same margin a tools gateway applies, ADR-0043). An identity
 * token fails the issuer check and is `token_invalid`; the body is the fixed
 * `unauthorized`, so a probe learns nothing about which check failed.
 *
 * The JWKS document is given in the environment when the construct knows it
 * (M-82); without it, or for a `kid` the document lacks, the JWKS route is
 * fetched once.
 */

import { createLocalJWKSet, createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type ActClaim, AGENT_AUDIENCE_PREFIX, agentChainOf, TRANSACTION_TOKEN_TYPE } from './mint';

/** A caller's token with this much life or less is refused: the replacement token must outlive the hop's stream. */
export const DELEGATION_EXP_MARGIN_SECONDS = 60;

/** The verified caller of a delegation. */
export interface DelegationCaller {
  readonly tenantId: string;
  /** The identity provider's `sub` (the token's `user`). */
  readonly sub: string;
  /** The calling agent (the token's `agent`). */
  readonly agent: string;
  /** The agents already in the chain, outermost first; empty on the first hop. */
  readonly chain: readonly string[];
  /** The caller's `act`, verified to end in the ingress role. */
  readonly act: ActClaim;
  readonly txn: string;
}

export class DelegationTokenError extends Error {
  constructor() {
    super('token_invalid');
    this.name = 'DelegationTokenError';
  }
}

/** Verifies the caller's transaction token; throws DelegationTokenError on any failure. */
export type DelegationTokenVerifier = (token: string | undefined) => Promise<DelegationCaller>;

export interface DelegationVerifierOptions {
  readonly issuer: string;
  readonly ingressRoleArn: string;
  /** The ingress's JWKS document, when the construct deployed it with the function (M-82). */
  readonly jwks?: string;
  /** Milliseconds since the epoch; tests inject it. */
  readonly now?: () => number;
}

export function delegationTokenVerifierFor(options: DelegationVerifierOptions): DelegationTokenVerifier {
  const remote = createRemoteJWKSet(new URL(`${options.issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000, cacheMaxAge: 300_000 });
  const local: JWTVerifyGetKey | undefined = options.jwks === undefined ? undefined : createLocalJWKSet(JSON.parse(options.jwks));
  return async (token) => {
    if (token === undefined || token.length === 0) {
      throw new DelegationTokenError();
    }
    const verifyOptions = {
      issuer: options.issuer,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'iat', 'sub'],
      currentDate: options.now === undefined ? undefined : new Date(options.now()),
    };
    let verified;
    try {
      try {
        verified = await jwtVerify(token, local ?? remote, verifyOptions);
      } catch (error) {
        if (local === undefined) {
          throw error;
        }
        verified = await jwtVerify(token, remote, verifyOptions); // a kid the deployed document lacks: ask the route once
      }
    } catch {
      throw new DelegationTokenError();
    }
    const { payload, protectedHeader } = verified;
    if (protectedHeader.typ !== TRANSACTION_TOKEN_TYPE) {
      throw new DelegationTokenError();
    }
    const { tenant_id: tenantId, user, agent, txn, act, exp } = payload as Record<string, unknown>;
    if (typeof tenantId !== 'string' || typeof user !== 'string' || typeof agent !== 'string' || typeof txn !== 'string' || typeof exp !== 'number') {
      throw new DelegationTokenError();
    }
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
    if (exp - nowSeconds <= DELEGATION_EXP_MARGIN_SECONDS) {
      throw new DelegationTokenError();
    }
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(`${AGENT_AUDIENCE_PREFIX}${agent}`)) {
      throw new DelegationTokenError();
    }
    const chain = agentChainOf(act, options.ingressRoleArn);
    if (chain === undefined) {
      throw new DelegationTokenError();
    }
    return { tenantId, sub: user, agent, chain, act: act as ActClaim, txn };
  };
}
