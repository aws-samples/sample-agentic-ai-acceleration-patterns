// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Compact JWS with the private key held in KMS (ADR-0037, spike V-12): the
 * signing input is hashed locally and KMS signs the digest
 * (`MessageType: DIGEST`; `RAW` takes at most 4,096 bytes, which a token at
 * the `scope` bound exceeds). ES256 signatures come back DER-encoded and are
 * converted to the JOSE `r || s` form. Verification uses Node `crypto` with
 * a public key only. No private key ever exists in this process.
 *
 * Used by the mint (transaction token, src/shared/mint.ts), the tools
 * interceptor (tenant context, src/tools/interceptor.function.ts) and the
 * tool-side library (src/tools/context.ts).
 */

import { createHash, createPublicKey, type KeyObject, verify as cryptoVerify } from 'node:crypto';
import { GetPublicKeyCommand, type KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { logRetries } from './logger';

export type JwsAlgorithm = 'RS256' | 'ES256';

/** The KMS signing algorithm for each JOSE algorithm. */
export const KMS_SIGNING_ALGORITHM: Record<JwsAlgorithm, 'RSASSA_PKCS1_V1_5_SHA_256' | 'ECDSA_SHA_256'> = {
  RS256: 'RSASSA_PKCS1_V1_5_SHA_256',
  ES256: 'ECDSA_SHA_256',
};

export interface JwsHeader {
  readonly alg: JwsAlgorithm;
  readonly typ: string;
  readonly kid: string;
}

export function base64url(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url');
}

/** `base64url(header) . base64url(payload)`. */
export function signingInput(header: JwsHeader, payload: object): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
}

/* eslint-disable no-bitwise -- DER length decoding */
/** A DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) as JOSE `r || s`, each `size` bytes (32 for P-256). */
export function derToJose(der: Uint8Array, size = 32): Buffer {
  const buf = Buffer.from(der);
  if (buf[0] !== 0x30) {
    throw new Error('derToJose: not a DER sequence');
  }
  let offset = 2;
  if (buf[1] & 0x80) {
    offset += buf[1] & 0x7f;
  }
  const readInt = (): Buffer => {
    if (buf[offset] !== 0x02) {
      throw new Error('derToJose: expected an INTEGER');
    }
    const length = buf[offset + 1];
    const value = buf.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    if (value.length > size) {
      return value.subarray(value.length - size);
    }
    return Buffer.concat([Buffer.alloc(size - value.length), value]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}
/* eslint-enable no-bitwise */

/** Signs a digest; returns the raw signature as KMS returns it (DER for ECDSA). */
export type DigestSigner = (digest: Uint8Array) => Promise<Uint8Array>;

/** A DigestSigner over KMS `Sign` with `MessageType: DIGEST`. */
export function kmsDigestSigner(kms: KMSClient, keyId: string, alg: JwsAlgorithm): DigestSigner {
  return async (digest) => {
    const command = new SignCommand({ KeyId: keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: KMS_SIGNING_ALGORITHM[alg] });
    let out;
    try {
      out = await kms.send(command);
    } catch (error) {
      // A throttle that beat every attempt: counted here, by name, before the
      // caller turns it into a 502 `mint_failed` without one.
      logRetries('kms', 'Sign', error, error);
      throw error;
    }
    logRetries('kms', 'Sign', out);
    if (out.Signature === undefined) {
      throw new Error('KMS Sign returned no signature');
    }
    return out.Signature;
  };
}

/** Builds and signs a compact JWS with `signer`. */
export async function signJws(header: JwsHeader, payload: object, signer: DigestSigner): Promise<string> {
  const input = signingInput(header, payload);
  const digest = createHash('sha256').update(input, 'utf8').digest();
  const raw = Buffer.from(await signer(digest));
  const signature = header.alg === 'ES256' ? derToJose(raw) : raw;
  return `${input}.${base64url(signature)}`;
}

export interface DecodedJws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly input: string;
  readonly signature: Buffer;
}

/** Splits and parses a compact JWS without checking it. Throws on a malformed value. */
export function decodeJws(token: string): DecodedJws {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('malformed JWS');
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
  if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
    throw new Error('malformed JWS');
  }
  return {
    header: header as Record<string, unknown>,
    payload: payload as Record<string, unknown>,
    input: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/** Verifies a compact JWS against one public key; returns the decoded parts or throws. */
export function verifyJws(token: string, key: KeyObject, allowed: readonly JwsAlgorithm[] = ['RS256', 'ES256']): DecodedJws {
  const decoded = decodeJws(token);
  const alg = decoded.header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') {
    throw new Error('unsupported alg');
  }
  if (!allowed.includes(alg)) {
    throw new Error('alg not allowed');
  }
  const ok =
    alg === 'ES256'
      ? cryptoVerify('sha256', Buffer.from(decoded.input), { key, dsaEncoding: 'ieee-p1363' }, decoded.signature)
      : cryptoVerify('sha256', Buffer.from(decoded.input), key, decoded.signature);
  if (!ok) {
    throw new Error('bad signature');
  }
  return decoded;
}

/** A public key from KMS `GetPublicKey` (SPKI DER). */
export async function kmsPublicKey(kms: KMSClient, keyId: string): Promise<{ key: KeyObject; keyId: string }> {
  const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (out.PublicKey === undefined || out.KeyId === undefined) {
    throw new Error('KMS GetPublicKey returned no key');
  }
  return {
    key: createPublicKey({ key: Buffer.from(out.PublicKey), format: 'der', type: 'spki' }),
    // KeyId comes back as an ARN; the `kid` is the bare key id (spike, spec §6.2.3).
    keyId: out.KeyId.split('/').pop()!,
  };
}

/** A JWK for a public key, with `kid`, `alg` and `use: sig` (spec §5.2). */
export function publicJwk(key: KeyObject, kid: string): Record<string, string> {
  const jwk = key.export({ format: 'jwk' }) as Record<string, string>;
  const alg = jwk.kty === 'EC' ? 'ES256' : 'RS256';
  return { ...jwk, kid, alg, use: 'sig' };
}

/** Canonical JSON: object keys sorted at every level; arrays in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The reserved tool argument that carries the signed tenant context (spec §6.2.4). */
export const CONTEXT_ARGUMENT = '_ri_ctx';

/** `base64url(sha256(canonical JSON of the arguments without _ri_ctx))` (spec §3.6). */
export function argsHash(args: Record<string, unknown> | undefined): string {
  const rest: Record<string, unknown> = { ...(args ?? {}) };
  delete rest[CONTEXT_ARGUMENT];
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('base64url');
}
