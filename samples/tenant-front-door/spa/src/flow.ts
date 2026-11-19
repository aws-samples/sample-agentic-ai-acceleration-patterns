// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sign-in flow of spec §3.5 with its browser effects passed in, so it
 * runs in Node tests: start sign-in in either mode, complete the callback,
 * and settle on one tenant, narrowing a `tenants` token first.
 */

import type { ConfigJson } from '../../src/shared/contracts';
import { ConfigError, Here, parseConfig, signInPlan } from './config';
import { narrowToken } from './exchange';
import type { FetchLike, KeyValueStorage, Sleep } from './http';
import { codeChallenge, makeVerifier } from './pkce';
import { authorizeUrl, clearPending, makeNonce, parseSigninState, savePending, signinStatePath, stateMatches, takePending } from './signin';
import { decodeClaims, namesTenant, redeemCode, sameTenant, tenantView, TokenSet } from './token';

export interface Env {
  readonly fetch: FetchLike;
  /** `sessionStorage`: holds the verifier and nonce across the redirect, never a token (ADR-0007). */
  readonly storage: KeyValueStorage;
  readonly sleep: Sleep;
  /** A full-page navigation (`location.assign`). */
  readonly navigate: (url: string) => void;
  readonly here: Here;
}

/** `/logout` on the page's own host: the router answers 302 to the issuer's logout endpoint (§3.5 step 5). */
export const LOGOUT_PATH = '/logout';

export async function loadConfig(env: Env): Promise<ConfigJson> {
  const res = await env.fetch('/config.json', { method: 'GET', credentials: 'same-origin' });
  if (!res.ok) throw new ConfigError(`config.json ${res.status}`);
  return parseConfig(await res.json());
}

/**
 * Starts sign-in. A dedicated domain goes to `signInHost` instead (§3.5).
 * `host` mode asks this host's `/signin-state` for the `state`; `single`
 * mode uses the nonce itself.
 */
export async function beginSignIn(env: Env, config: ConfigJson): Promise<void> {
  const plan = signInPlan(config, env.here);
  if (plan.kind === 'redirect') {
    env.navigate(plan.url);
    return;
  }
  const verifier = makeVerifier();
  const nonce = makeNonce();
  let state = nonce;
  if (plan.mode === 'host') {
    const res = await env.fetch(signinStatePath(nonce), { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`signin-state ${res.status}`);
    state = parseSigninState(await res.json());
  }
  savePending(env.storage, { verifier, nonce });
  env.navigate(authorizeUrl(config, { redirectUri: plan.redirectUri, state, challenge: await codeChallenge(verifier) }));
}

/** A signed-in tab: what memory holds. */
export interface Session {
  /** The code exchange's tokens; the refresh token is the exchange's subject. */
  readonly subject: TokenSet;
  /** The token for `/api/*` and `/agents/*`, naming exactly `tenantId`. */
  readonly accessToken: string;
  readonly tenantId: string;
  /** The tenants a `tenants` token lists, for switching in `single` mode. */
  readonly tenants?: readonly string[];
}

export type Outcome =
  | { readonly kind: 'signed-in'; readonly session: Session }
  /** `single` mode on `appDomain` with a `tenants` token: the user picks. */
  | { readonly kind: 'pick-tenant'; readonly subject: TokenSet; readonly tenants: readonly string[] }
  /** The exchange did not answer; the refresh token is kept for a retry (§7.2). */
  | { readonly kind: 'unavailable'; readonly subject: TokenSet; readonly tenantId: string }
  /** A fixed message; nothing from the issuer is shown (§7.2). */
  | { readonly kind: 'failed' }
  /** The token names another tenant: discard it and sign out before any API call (§3.5 step 4). */
  | { readonly kind: 'sign-out' };

/** Completes the callback. The saved verifier and nonce are deleted on every outcome. */
export async function completeSignIn(env: Env, config: ConfigJson, code: string, state: string): Promise<Outcome> {
  const pending = takePending(env.storage);
  const plan = signInPlan(config, env.here);
  if (pending === undefined || plan.kind !== 'here' || !stateMatches(state, plan.mode, pending)) return { kind: 'failed' };
  let subject: TokenSet;
  try {
    subject = await redeemCode(env.fetch, config, { code, verifier: pending.verifier, redirectUri: plan.redirectUri });
  } catch {
    return { kind: 'failed' };
  }
  return settleTenant(env, config, subject, plan.expectedTenant);
}

/**
 * Settles on one tenant: `expected` is the host's tenant, or in `single`
 * mode the one the user picked. A `tenants` token is narrowed to it first,
 * and the narrowed token must name it (§3.5).
 */
export async function settleTenant(env: Env, config: ConfigJson, subject: TokenSet, expected: string | undefined): Promise<Outcome> {
  const view = tenantView(decodeClaims(subject.accessToken));
  if (view.kind === 'none') return { kind: 'sign-out' };
  if (view.kind === 'single') {
    if (expected !== undefined && !sameTenant(view.tenantId, expected)) return { kind: 'sign-out' };
    return { kind: 'signed-in', session: { subject, accessToken: subject.accessToken, tenantId: view.tenantId } };
  }
  if (expected === undefined) return { kind: 'pick-tenant', subject, tenants: view.tenants };
  if (!view.tenants.some((t) => sameTenant(t, expected)) || subject.refreshToken === undefined) return { kind: 'sign-out' };
  const r = await narrowToken(env, config, { refreshToken: subject.refreshToken, tenantId: expected });
  if (!r.ok) return r.reason === 'unavailable' ? { kind: 'unavailable', subject, tenantId: expected } : { kind: 'sign-out' };
  if (!namesTenant(decodeClaims(r.accessToken), expected)) return { kind: 'sign-out' };
  return { kind: 'signed-in', session: { subject, accessToken: r.accessToken, tenantId: expected, tenants: view.tenants } };
}

/** Drops the saved sign-in values and leaves through `/logout`; the caller drops its in-memory session first. */
export function signOut(env: Env): void {
  clearPending(env.storage);
  env.navigate(LOGOUT_PATH);
}
