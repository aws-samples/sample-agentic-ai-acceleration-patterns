// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Byte helpers on Web Crypto and `btoa`/`atob`, the same in the browser and in Node. */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url to UTF-8 text. Throws on characters outside base64url or bytes that are not UTF-8. */
export function base64UrlDecodeText(s: string): string {
  if (!BASE64URL.test(s) || s.length % 4 === 1) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** `byteCount` bytes from the platform's cryptographic random source, base64url-encoded. */
export function randomBase64Url(byteCount: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
