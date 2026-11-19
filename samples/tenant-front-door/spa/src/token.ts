// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tokens (spec §3.5, ADR-0007): the code exchange, reading the tenant
 * claims, and the tenant check after sign-in. Tokens live in memory only;
 * nothing here touches storage.
 */

import type { ConfigJson } from '../../src/shared/contracts';
import { MULTI_TENANT_CLAIM, TENANT_CLAIM } from '../../src/shared/contracts';
import { base64UrlDecodeText } from './encoding';
import type { FetchLike } from './http';

export interface TokenSet {
  readonly accessToken: string;
  /** The subject of the token exchange; kept in memory, sent only to the token and exchange endpoints (§3.5). */
  readonly refreshToken?: string;
}

export class SignInError extends Error {}

/** Authorization code + PKCE at the issuer's token endpoint: a form `POST`, so a CORS simple request. */
export async function redeemCode(
  fetchFn: FetchLike,
  config: ConfigJson,
  p: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  let res;
  try {
    res = await fetchFn(config.tokenEndpoint, { method: 'POST', body, credentials: 'omit' });
  } catch {
    throw new SignInError('token endpoint unreachable');
  }
  if (!res.ok) throw new SignInError(`token endpoint ${res.status}`);
  const t = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (typeof t?.access_token !== 'string') throw new SignInError('no access_token');
  return {
    accessToken: t.access_token,
    refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
  };
}

/** The payload of a JWT, not verified: the SPA reads its own token, the router and the cell verify (§3.5). */
export function decodeClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const c: unknown = JSON.parse(base64UrlDecodeText(parts[1]));
    return typeof c === 'object' && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export type TenantView =
  | { readonly kind: 'single'; readonly tenantId: string }
  /** A `shared-pool-multi-tenant` token: narrow it before any `/api/*` or `/agents/*` call. */
  | { readonly kind: 'multi'; readonly tenants: readonly string[] }
  | { readonly kind: 'none' };

/**
 * `claim` defaults to the `tenantClaim` input's default. `/config.json`
 * does not carry the input, so a deployer who changes it changes this too.
 */
export function tenantView(claims: Record<string, unknown> | undefined, claim: string = TENANT_CLAIM): TenantView {
  if (claims === undefined) return { kind: 'none' };
  const multi = claims[MULTI_TENANT_CLAIM];
  if (multi !== undefined) {
    const ok = Array.isArray(multi) && multi.length > 0 && multi.every((t) => typeof t === 'string' && t.length > 0);
    return ok ? { kind: 'multi', tenants: multi as string[] } : { kind: 'none' };
  }
  const one = claims[claim];
  return typeof one === 'string' && one.length > 0 ? { kind: 'single', tenantId: one } : { kind: 'none' };
}

export function sameTenant(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A token names exactly `expected`: one tenant claim, compared case-insensitively, no `tenants` list (§3.5 step 4). */
export function namesTenant(claims: Record<string, unknown> | undefined, expected: string, claim: string = TENANT_CLAIM): boolean {
  const v = tenantView(claims, claim);
  return v.kind === 'single' && sameTenant(v.tenantId, expected);
}
