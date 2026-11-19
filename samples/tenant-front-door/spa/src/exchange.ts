// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The multi-tenant token exchange (spec §3.5, §7.2; tenant-identity §5.4,
 * §5.4.1): narrow a `tenants` token to one tenant with RFC 8693.
 */

import type { ConfigJson } from '../../src/shared/contracts';
import type { FetchLike, Sleep } from './http';

export const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const TOKEN_TYPE_REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token';
export const RESOURCE_PREFIX = 'urn:tenant-identity:tenant:';

/** Backoff before the second and third attempt (§7.2): at most two retries. */
export const EXCHANGE_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** A tenant-identity catalogue scope (`<owner>/<action>`, tenant-identity §4.4). */
const CATALOGUE_SCOPE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

export type ExchangeResult =
  | { readonly ok: true; readonly accessToken: string }
  /**
   * `unavailable`: network errors (API Gateway's own answers carry no CORS
   * header) or `server_error` after the retries; the caller keeps the
   * refresh token and shows "try again later". `refused`: a 4xx, such as
   * `invalid_target`.
   */
  | { readonly ok: false; readonly reason: 'unavailable' | 'refused' };

/**
 * The `scope` the exchange accepts: the resource-server scopes of
 * `/config.json`'s `scopes`. tenant-identity refuses OIDC scopes such as
 * `openid` with `invalid_scope`, because they are not catalogue names.
 */
export function exchangeScope(scopes: string): string {
  return [...new Set(scopes.split(' ').filter((s) => CATALOGUE_SCOPE.test(s)))].join(' ');
}

/** `exchangeEndpoint` when `/config.json` names one, else the issuer's token endpoint (§3.5). */
export function exchangeUrl(config: ConfigJson): string {
  return config.exchangeEndpoint ?? config.tokenEndpoint;
}

/**
 * One form `POST` with no header the SPA sets and `credentials: 'omit'`,
 * so the browser sends it as a CORS simple request with no preflight: the
 * exchange API has no `OPTIONS` route (§7.2). A `URLSearchParams` body sets
 * `Content-Type: application/x-www-form-urlencoded;charset=UTF-8` itself.
 */
export async function narrowToken(
  deps: { readonly fetch: FetchLike; readonly sleep: Sleep },
  config: ConfigJson,
  p: { readonly refreshToken: string; readonly tenantId: string },
): Promise<ExchangeResult> {
  const scope = exchangeScope(config.scopes);
  if (scope === '') return { ok: false, reason: 'refused' };
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: config.clientId,
    subject_token: p.refreshToken,
    subject_token_type: TOKEN_TYPE_REFRESH,
    resource: `${RESOURCE_PREFIX}${p.tenantId.toUpperCase()}`,
    scope,
  });
  const url = exchangeUrl(config);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await deps.fetch(url, { method: 'POST', body, credentials: 'omit' });
      if (res.ok) {
        const t = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
        return typeof t?.access_token === 'string' ? { ok: true, accessToken: t.access_token } : { ok: false, reason: 'refused' };
      }
      if (res.status < 500) return { ok: false, reason: 'refused' };
    } catch {
      // A network error: API Gateway's own answers carry no CORS header (§7.2).
    }
    if (attempt >= EXCHANGE_RETRY_DELAYS_MS.length) return { ok: false, reason: 'unavailable' };
    await deps.sleep(EXCHANGE_RETRY_DELAYS_MS[attempt]);
  }
}
