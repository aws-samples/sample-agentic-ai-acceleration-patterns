// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sign-in round trip (spec §3.5, ADR-0007, ADR-0016): the nonce and
 * PKCE verifier kept in `sessionStorage` across the redirect, the
 * `/signin-state` call in `host` mode, the authorize URL, and the checks
 * on the callback.
 */

import type { ConfigJson, SigninStateResponse } from '../../src/shared/contracts';
import { SIGNIN_NONCE, SIGNIN_STATE_QUERY_NONCE } from '../../src/shared/contracts';
import { base64UrlDecodeText, randomBase64Url } from './encoding';
import type { KeyValueStorage } from './http';

/** The one `sessionStorage` key: the verifier and nonce, from the authorize redirect until the callback. No token is ever stored. */
export const PENDING_KEY = 'tfd.pending-signin';

export interface PendingSignIn {
  readonly verifier: string;
  readonly nonce: string;
}

/** 32 random bytes, 43 base64url characters, inside `SIGNIN_NONCE`. */
export function makeNonce(): string {
  return randomBase64Url(32);
}

export function savePending(storage: KeyValueStorage, pending: PendingSignIn): void {
  storage.setItem(PENDING_KEY, JSON.stringify({ v: 1, verifier: pending.verifier, nonce: pending.nonce }));
}

/** Reads and deletes the saved values. Deletes them on every outcome, a malformed entry included. */
export function takePending(storage: KeyValueStorage): PendingSignIn | undefined {
  const raw = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY);
  if (raw === null) return undefined;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p.v !== 1 || typeof p.verifier !== 'string' || typeof p.nonce !== 'string' || !SIGNIN_NONCE.test(p.nonce)) return undefined;
    return { verifier: p.verifier, nonce: p.nonce };
  } catch {
    return undefined;
  }
}

export function clearPending(storage: KeyValueStorage): void {
  storage.removeItem(PENDING_KEY);
}

/** `GET /signin-state?nonce=<base64url>` on the page's own host (§3.3 step 8). */
export function signinStatePath(nonce: string): string {
  return `/signin-state?${new URLSearchParams({ [SIGNIN_STATE_QUERY_NONCE]: nonce }).toString()}`;
}

export function parseSigninState(raw: unknown): string {
  const s = (raw as Partial<SigninStateResponse> | null)?.state;
  if (typeof s !== 'string' || s.length === 0 || s.length > 1024) throw new Error('signin-state: no state');
  return s;
}

export function authorizeUrl(
  config: ConfigJson,
  p: { readonly redirectUri: string; readonly state: string; readonly challenge: string },
): string {
  const url = new URL(config.authorizeEndpoint);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: p.redirectUri,
    scope: config.scopes,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  for (const [k, v] of q) url.searchParams.set(k, v);
  return url.toString();
}

export type Callback =
  | { readonly kind: 'none' }
  /** The issuer sent `error`, or the query is malformed. The SPA shows a fixed message, never `error_description` (§7.2). */
  | { readonly kind: 'error' }
  | { readonly kind: 'code'; readonly code: string; readonly state: string };

/** Reads the query the inline callback script saved (§7.1 Reports). */
export function parseCallback(search: string): Callback {
  const q = new URLSearchParams(search);
  if (q.has('error')) return { kind: 'error' };
  const codes = q.getAll('code');
  const states = q.getAll('state');
  if (codes.length === 0 && states.length === 0) return { kind: 'none' };
  if (codes.length !== 1 || states.length !== 1 || codes[0] === '' || states[0] === '') return { kind: 'error' };
  return { kind: 'code', code: codes[0], state: states[0] };
}

/**
 * The nonce a callback `state` carries. `single` mode: the SPA's own
 * `state` is the nonce. `host` mode: the router's `state`, whose payload
 * holds it as `n`; the SPA cannot check the HMAC and does not need to,
 * because the nonce and the verifier bind the code to this tab (§3.5).
 */
export function stateNonce(state: string, mode: 'single' | 'host'): string | undefined {
  if (mode === 'single') return state;
  const parts = state.split('.');
  if (parts.length !== 2) return undefined;
  try {
    const payload: unknown = JSON.parse(base64UrlDecodeText(parts[0]));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
    const n = (payload as Record<string, unknown>).n;
    return typeof n === 'string' ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The callback is this tab's only when the `state`'s nonce equals the saved one (§3.5 step 4). */
export function stateMatches(state: string, mode: 'single' | 'host', pending: PendingSignIn): boolean {
  const n = stateNonce(state, mode);
  return n !== undefined && SIGNIN_NONCE.test(n) && n === pending.nonce;
}
