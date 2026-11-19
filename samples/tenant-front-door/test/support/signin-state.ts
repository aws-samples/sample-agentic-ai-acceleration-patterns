// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Reference implementation of the sign-in `state` (spec §3.5, ADR-0016),
 * for tests only. The router mints and checks the state inside a
 * CloudFront Function and cannot import this; it is tested against
 * `test/fixtures/signin-state.json`, which this module checks.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { SigninStatePayload } from '../../src/shared/contracts';
import type { SigninEntry } from '../../src/shared/route-table';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(keyB64: string, data: string): Buffer {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(data).digest();
}

/** `base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(encoded payload))`, signed with `kid`'s key. */
export function mintState(signin: SigninEntry, payload: SigninStatePayload): string {
  const key = signin.k[payload.kid];
  if (key === undefined) throw new Error(`no key ${payload.kid}`);
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${b64url(hmac(key, encoded))}`;
}

export type StateVerdict = { readonly ok: true; readonly payload: SigninStatePayload } | { readonly ok: false; readonly why: string };

/** Checks shape, `kid`, HMAC and expiry, in that order. */
export function verifyState(signin: SigninEntry, state: string, nowSeconds: number): StateVerdict {
  const parts = state.split('.');
  if (parts.length !== 2) return { ok: false, why: 'shape' };
  const [encoded, mac] = parts;
  let payload: SigninStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SigninStatePayload;
  } catch {
    return { ok: false, why: 'shape' };
  }
  if (payload.v !== 1 || typeof payload.kid !== 'string' || typeof payload.h !== 'string' || typeof payload.exp !== 'number') {
    return { ok: false, why: 'shape' };
  }
  const key = signin.k[payload.kid];
  if (key === undefined) return { ok: false, why: 'kid' };
  const expected = hmac(key, encoded);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, why: 'hmac' };
  if (payload.exp <= nowSeconds) return { ok: false, why: 'expired' };
  return { ok: true, payload };
}
