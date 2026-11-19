// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** PKCE (RFC 7636) with `S256`, for the authorization code flow (spec §3.5). */

import { base64UrlEncode, randomBase64Url, sha256 } from './encoding';

/** 32 random bytes, 43 base64url characters: inside RFC 7636's 43 to 128. */
export function makeVerifier(): string {
  return randomBase64Url(32);
}

/** `BASE64URL(SHA256(ASCII(verifier)))`. */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}
