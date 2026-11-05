// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { constants, generateKeyPairSync, type KeyObject, privateEncrypt } from 'node:crypto';
import type { DigestSigner } from '../src/shared/jws';

/** The DER DigestInfo prefix of a SHA-256 digest (RFC 8017 §9.2), what KMS adds for RSASSA_PKCS1_V1_5_SHA_256 with MessageType DIGEST. */
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');

export interface LocalRsaKey {
  readonly publicKey: KeyObject;
  /** Behaves like KMS `Sign` (RSASSA_PKCS1_V1_5_SHA_256, MessageType DIGEST) on a test-only key. */
  readonly signer: DigestSigner;
  /** Digests signed so far (one per KMS call). */
  readonly calls: Uint8Array[];
}

/** A test RSA key whose signer stands in for KMS. The private key never leaves this helper. */
export function localRsaKey(): LocalRsaKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: Uint8Array[] = [];
  const signer: DigestSigner = async (digest) => {
    calls.push(digest);
    return privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_DIGEST_INFO, Buffer.from(digest)]));
  };
  return { publicKey, signer, calls };
}
