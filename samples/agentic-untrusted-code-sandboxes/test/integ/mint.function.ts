// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The TEST-ONLY token mint (spec §8, S-12). It signs transaction tokens with
 * the integration ingress's own signing key (`TokenSigner.grantSign` on the
 * function), because no consumer can sign a token for an ingress it does not
 * own. It exists only in the integration app, never in the construct or the
 * demo app (threat T-88, M-60), and the driver invokes it with its own
 * credentials. It never logs: tokens go back in the invoke response only.
 *
 * Copied, with the claims of agentic-runtime-isolation's transaction token
 * (spec §6.2.2 of that sample), from its integration test's mint. A stated
 * shortcut: a consumer gets a token from the ingress by presenting an
 * identity token (the `parse` step's agent call does that once).
 *
 * `forgeContext` returns a tool context signed with this key, which is NOT
 * the tools' context key, so the `forged` step can present a context the
 * tool must refuse.
 */

import { createHash, randomUUID } from 'node:crypto';

/** The two calls of the KMS client the mint uses; the Lambda runtime provides the SDK, so the sample declares no dependency on it. */
interface KmsLike {
  send(command: unknown): Promise<{ Signature?: Uint8Array }>;
}
interface KmsModule {
  KMSClient: new (config: Record<string, unknown>) => KmsLike;
  SignCommand: new (input: Record<string, unknown>) => unknown;
}

export const INTEG_MINT_ENV = {
  ISSUER: 'RC_INTEG_ISSUER',
  KEY_ID: 'RC_INTEG_KEY_ID',
  INGRESS_ROLE_ARN: 'RC_INTEG_INGRESS_ROLE_ARN',
} as const;

const TRANSACTION_TOKEN_TYPE = 'txn+jwt';
const CONTEXT_TYPE = 'ri-ctx+jwt';

export interface IntegMintEvent {
  readonly tenantId: string;
  readonly sub: string;
  readonly agent: string;
  readonly scope: string;
  readonly gateways: string[];
  /** Default 300; the tools gateway refuses a token with 60 s or less left. */
  readonly ttlSeconds?: number;
  /** Instead of a token: a tenant context signed with this key, which is not the tools' context key. */
  readonly forgeContext?: { readonly tenantId: string; readonly tool: string; readonly args?: Record<string, unknown> };
}

export interface IntegMintOutput {
  readonly token?: string;
  readonly context?: string;
  readonly kid: string;
}

const b64u = (v: string | Uint8Array): string => Buffer.from(v).toString('base64url');

/** Canonical JSON: object keys sorted at every level (the producer's `argsHash` input). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const argsHash = (args: Record<string, unknown> = {}): string => createHash('sha256').update(canonicalJson(args), 'utf8').digest('base64url');

/** The claims of a transaction token for one tenant, as the ingress mints them. Pure. */
export function claimsFor(
  event: IntegMintEvent, config: { issuer: string; ingressRoleArn: string }, nowSeconds: number, ids: { txn: string; jti: string },
): Record<string, unknown> {
  return {
    iss: config.issuer,
    sub: `${event.tenantId}#${event.sub}`,
    user: event.sub,
    tenant_id: event.tenantId,
    agent: event.agent,
    scope: event.scope,
    aud: [`agent:${event.agent}`, ...[...new Set(event.gateways)].sort().map((g) => `tools-gateway:${g}`)],
    act: { sub: config.ingressRoleArn },
    txn: ids.txn,
    iat: nowSeconds,
    exp: nowSeconds + (event.ttlSeconds ?? 300),
    jti: ids.jti,
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
}

export type DigestSigner = (digest: Uint8Array) => Promise<Uint8Array>;

function kmsSigner(keyId: string): DigestSigner {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { KMSClient, SignCommand } = require('@aws-sdk/client-kms') as KmsModule;
  const kms = new KMSClient({});
  return async (digest) => {
    const out = await kms.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' }));
    if (!out.Signature) throw new Error('KMS Sign returned no signature');
    return out.Signature;
  };
}

/** A compact RS256 JWS over `payload`, the digest signed by `signer`. */
export async function signJws(typ: string, kid: string, payload: object, signer: DigestSigner): Promise<string> {
  const input = `${b64u(JSON.stringify({ alg: 'RS256', typ, kid }))}.${b64u(JSON.stringify(payload))}`;
  const signature = await signer(createHash('sha256').update(input, 'utf8').digest());
  return `${input}.${b64u(signature)}`;
}

export async function mint(
  event: IntegMintEvent, signer: DigestSigner = kmsSigner(env(INTEG_MINT_ENV.KEY_ID)), now = Date.now(),
): Promise<IntegMintOutput> {
  const kid = env(INTEG_MINT_ENV.KEY_ID);
  const seconds = Math.floor(now / 1000);
  if (event.forgeContext !== undefined) {
    const f = event.forgeContext;
    const payload = {
      tenant_id: f.tenantId,
      sub: `${f.tenantId}#${event.sub}`,
      user: event.sub,
      agent: event.agent,
      tool: f.tool,
      argsHash: argsHash(f.args),
      txn: randomUUID(),
      iat: seconds,
      exp: seconds + 60,
    };
    return { context: await signJws(CONTEXT_TYPE, kid, payload, signer), kid };
  }
  const config = { issuer: env(INTEG_MINT_ENV.ISSUER), ingressRoleArn: env(INTEG_MINT_ENV.INGRESS_ROLE_ARN) };
  const claims = claimsFor(event, config, seconds, { txn: randomUUID(), jti: randomUUID() });
  return { token: await signJws(TRANSACTION_TOKEN_TYPE, kid, claims, signer), kid };
}

export const handler = async (event: IntegMintEvent): Promise<IntegMintOutput> => mint(event);
