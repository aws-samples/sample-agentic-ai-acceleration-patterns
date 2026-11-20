// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test helper: signs a tenant context the way the tools gateway interceptor
 * does (agentic-runtime-isolation spec §6.2.4: an ES256 JWS of type
 * `ri-ctx+jwt`, with `argsHash` over the canonical JSON of the arguments), so
 * the tests run the producer's real `toolHandler` and `verifyToolContext`.
 * A change in the producer's format fails these tests rather than passing
 * against a copy.
 */

import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

export const CONTEXT_ARGUMENT = '_ri_ctx';

export interface TestKey {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export function testKey(): TestKey {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const b64 = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

export interface SignOptions {
  readonly tenantId: string;
  /** `<target>/<tool>` the context is signed for. */
  readonly tool?: string;
  /** The arguments the signature covers; `signedFor` differs from the call's arguments to model tampering. */
  readonly signedFor: Record<string, unknown>;
  readonly key: TestKey;
  readonly nowSeconds?: number;
}

/** A signed tenant context for `signedFor`. */
export function signContext(options: SignOptions): string {
  const exp = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) + 60;
  const rest: Record<string, unknown> = { ...options.signedFor };
  delete rest[CONTEXT_ARGUMENT];
  const header = { alg: 'ES256', typ: 'ri-ctx+jwt' };
  const payload = {
    tenant_id: options.tenantId,
    sub: `${options.tenantId}#user-1`,
    user: 'user-1',
    agent: 'agent-1',
    tool: options.tool ?? 'run-code/run_code',
    txn: 'txn-1',
    exp,
    argsHash: createHash('sha256').update(canonicalJson(rest), 'utf8').digest('base64url'),
  };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const signature = createSign('SHA256').update(input).sign({ key: options.key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64(signature)}`;
}
