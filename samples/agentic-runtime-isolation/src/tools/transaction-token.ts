// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Transaction-token verification shared by the tools gateway's REQUEST
 * interceptor and RESPONSE filter (spec §5.4, ADR-0040). This module has no
 * load-time side effects: importing it reads no environment and builds no
 * client, so the RESPONSE filter does not need the interceptor's context key
 * (integ run 7: importing interceptor.function.ts ran its eager dependency
 * build, which requires RI_CONTEXT_KEY_ID, and the filter died at init).
 */

import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AGENT_AUDIENCE_PREFIX, toolsGatewayAudience, TRANSACTION_TOKEN_TYPE } from '../shared/mint';

/** Environment variables of the interceptor. */
export const TOOLS_ENV = {
  ISSUER: 'RI_ISSUER',
  INGRESS_ROLE_ARN: 'RI_INGRESS_ROLE_ARN',
  CONTEXT_KEY_ID: 'RI_CONTEXT_KEY_ID',
  CONTEXT_LIFETIME_SECONDS: 'RI_CONTEXT_LIFETIME_SECONDS',
  /** (ADR-0041) This gateway's name; the token's `aud` must hold `tools-gateway:<name>`. */
  GATEWAY_NAME: 'RI_TOOLS_GATEWAY_NAME',
} as const;

/** Refusal reasons (spec §5.4); the response body is `forbidden: <reason>`. */
export type ToolRefusal = 'token_invalid' | 'aud_mismatch' | 'act_missing' | 'tool_not_granted';

/** What verifying a transaction token needs (the REQUEST and the RESPONSE interceptor share it). */
export interface TokenVerification {
  readonly config: { readonly issuer: string; readonly ingressRoleArn: string; readonly gatewayName: string };
  readonly getKey: JWTVerifyGetKey;
  readonly now?: () => number;
}

export class Refusal extends Error {
  constructor(readonly reason: ToolRefusal) {
    super(reason);
  }
}

/** The verified transaction-token claims the interceptor acts on. */
export interface ToolCaller {
  readonly tenantId: string;
  readonly sub: string;
  readonly user: string;
  readonly agent: string;
  readonly scope: string;
  readonly txn: string;
}

/** Verifies the transaction token (step 1). Throws Refusal. */
export async function verifyTransactionToken(token: string | undefined, deps: TokenVerification): Promise<ToolCaller> {
  if (token === undefined) {
    throw new Refusal('token_invalid');
  }
  let payload: JWTPayload;
  let typ: string | undefined;
  try {
    const verified = await jwtVerify(token, deps.getKey, {
      issuer: deps.config.issuer,
      audience: toolsGatewayAudience(deps.config.gatewayName),
      algorithms: ['RS256', 'ES256'],
      currentDate: deps.now === undefined ? undefined : new Date(deps.now()),
    });
    payload = verified.payload;
    typ = verified.protectedHeader.typ;
  } catch {
    throw new Refusal('token_invalid');
  }
  if (typ !== TRANSACTION_TOKEN_TYPE) {
    throw new Refusal('aud_mismatch');
  }
  const { tenant_id: tenantId, sub, user, agent, scope, txn, act } = payload as Record<string, unknown>;
  if (typeof tenantId !== 'string' || typeof sub !== 'string' || typeof user !== 'string' || typeof agent !== 'string' || typeof txn !== 'string') {
    throw new Refusal('token_invalid');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(`${AGENT_AUDIENCE_PREFIX}${agent}`)) {
    throw new Refusal('aud_mismatch');
  }
  const actSub = typeof act === 'object' && act !== null ? (act as Record<string, unknown>).sub : undefined;
  if (actSub !== deps.config.ingressRoleArn) {
    throw new Refusal('act_missing');
  }
  return { tenantId, sub, user, agent, scope: typeof scope === 'string' ? scope : '', txn };
}
