// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The TEST-ONLY mint (spec §8 steps 14 to 18, 21, 22): signs transaction
 * tokens with the ingress's signing key, `TokenSigner.grantSign` granted, so
 * the integration driver can present tokens the ingress itself would never
 * mint (no `act`, another `act.sub`, a narrowed `aud`, a foreign gateway, an
 * altered `tenant_id`). It exists only on the stacks of
 * test/integ.runtime.ts, never in the demo stack (src/demo.cdk.ts), and the
 * runner invokes it with its own credentials. It never logs: the token goes
 * back in the invoke response only.
 */

import { randomUUID } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { base64url, kmsDigestSigner, signJws, argsHash } from '../../src/shared/jws';
import { TRANSACTION_TOKEN_TYPE, transactionClaims } from '../../src/shared/mint';
import { CONTEXT_TYPE } from '../../src/tools/context';

export const INTEG_MINT_ENV = {
  ISSUER: 'RI_INTEG_ISSUER',
  KEY_ID: 'RI_INTEG_KEY_ID',
  INGRESS_ROLE_ARN: 'RI_INTEG_INGRESS_ROLE_ARN',
} as const;

export interface IntegMintEvent {
  readonly tenantId: string;
  /** The identity provider's `sub`; the token's `sub` is `<tenantId>#<sub>`. */
  readonly sub: string;
  readonly agent: string;
  readonly scope: string;
  readonly gateways: string[];
  /** Default 300. */
  readonly ttlSeconds?: number;
  /** Claim overrides; a `null` value removes the claim (for example `act`). */
  readonly claims?: Record<string, unknown>;
  /** The JOSE `typ`; default `txn+jwt`. */
  readonly typ?: string;
  /** Rewrites `tenant_id` AFTER signing, so the signature no longer matches (step 15). */
  readonly tamperTenantId?: string;
  /** Instead of a token: a tenant context signed with this key, which is NOT ToolContextKey (steps 15, 22). */
  readonly forgeContext?: { readonly tenantId: string; readonly tool: string; readonly args?: Record<string, unknown> };
}

export interface IntegMintOutput {
  readonly token?: string;
  readonly context?: string;
  readonly kid: string;
  readonly exp?: number;
}

const kms = new KMSClient({});

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export async function mint(event: IntegMintEvent, signer = kmsDigestSigner(kms, env(INTEG_MINT_ENV.KEY_ID), 'RS256'), now = Date.now()): Promise<IntegMintOutput> {
  const kid = env(INTEG_MINT_ENV.KEY_ID);
  const seconds = Math.floor(now / 1000);
  if (event.forgeContext !== undefined) {
    const payload = {
      tenant_id: event.forgeContext.tenantId,
      sub: `${event.forgeContext.tenantId}#${event.sub}`,
      user: event.sub,
      agent: event.agent,
      tool: event.forgeContext.tool,
      argsHash: argsHash(event.forgeContext.args ?? {}),
      txn: randomUUID(),
      iat: seconds,
      exp: seconds + 60,
    };
    return { context: await signJws({ alg: 'RS256', typ: CONTEXT_TYPE, kid }, payload, signer), kid };
  }
  const base: Record<string, unknown> = {
    ...transactionClaims(
      {
        tenantId: event.tenantId,
        sub: event.sub,
        agent: event.agent,
        scope: event.scope,
        gateways: event.gateways,
        versions: { tenant: 0, agent: 0 },
      },
      { issuer: env(INTEG_MINT_ENV.ISSUER), ttlSeconds: event.ttlSeconds ?? 300, ingressRoleArn: env(INTEG_MINT_ENV.INGRESS_ROLE_ARN) },
      seconds,
      { txn: randomUUID(), jti: randomUUID() },
    ),
  };
  for (const [name, value] of Object.entries(event.claims ?? {})) {
    if (value === null) {
      delete base[name];
    } else {
      base[name] = value;
    }
  }
  let token = await signJws({ alg: 'RS256', typ: event.typ ?? TRANSACTION_TOKEN_TYPE, kid }, base, signer);
  if (event.tamperTenantId !== undefined) {
    const [header, , signature] = token.split('.');
    token = `${header}.${base64url(JSON.stringify({ ...base, tenant_id: event.tamperTenantId }))}.${signature}`;
  }
  return { token, kid, exp: typeof base.exp === 'number' ? base.exp : undefined };
}

export const handler = async (event: IntegMintEvent): Promise<IntegMintOutput> => mint(event);
