// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tools gateway REQUEST interceptor (spec C-15a, §3.6, P-15; ADR-0034,
 * ADR-0040). It runs BEFORE Policy (spike V-11), so it is the first wall:
 *
 * 1. re-verify the transaction token against the ingress JWKS (cached,
 *    refreshed on an unknown `kid`), with header `typ: txn+jwt` (the Gateway
 *    does not check `typ`, spike V-8), `iss` = the ingress issuer, `aud`
 *    holding `tools-gateway` and `agent:<agent>` for the token's own agent,
 *    `act.sub` = the ingress role, and `exp` in the future;
 * 2. on `tools/call`, check the called tool against `scope`;
 * 3. compute `argsHash` over the arguments (without `_ri_ctx`, after a
 *    client `tenantId` is overwritten with the token's), sign the tenant
 *    context with `ToolContextKey` (KMS `Sign`), and put it in `_ri_ctx`,
 *    overwriting anything the client sent;
 * 4. write `tool admitted`, or refuse with a fixed reason and write
 *    `tool refused` with the tenant (P-9).
 *
 * On `tools/list` it verifies and logs only; Policy filters the list. Any
 * failure is a refusal; none passes the call on, and a throw or timeout is
 * a Gateway 5xx (fail-closed, V-11). It never logs a token or a context
 * value, only names.
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CONTEXT_TYPE } from './context';
import { catalogueToolName } from '../shared/cedar';
import { requireEnv, isLambdaRuntime } from '../shared/config';
import { scopeGrantsTool } from '../shared/grant';
import { headerValue } from '../shared/headers';
import { sharedHandler } from '../shared/http';
import { argsHash, CONTEXT_ARGUMENT, type DigestSigner, kmsDigestSigner, signJws } from '../shared/jws';
import { errorName, log } from '../shared/logger';
import { AGENT_AUDIENCE_PREFIX, TOOLS_GATEWAY_AUDIENCE, TRANSACTION_TOKEN_TYPE } from '../shared/mint';
import { bearerToken } from '../shared/verifier';

/** The tool argument a client might use to name a tenant; overwritten with the token's (P-15). */
export const TENANT_ARGUMENT = 'tenantId';

/** Environment variables of the interceptor. */
export const TOOLS_ENV = {
  ISSUER: 'RI_ISSUER',
  INGRESS_ROLE_ARN: 'RI_INGRESS_ROLE_ARN',
  CONTEXT_KEY_ID: 'RI_CONTEXT_KEY_ID',
  CONTEXT_LIFETIME_SECONDS: 'RI_CONTEXT_LIFETIME_SECONDS',
} as const;

/** Refusal reasons (spec §5.4); the response body is `forbidden: <reason>`. */
export type ToolRefusal = 'token_invalid' | 'aud_mismatch' | 'act_missing' | 'tool_not_granted';

/** The MCP REQUEST interceptor event, as spike V-10 observed it. */
export interface ToolInterceptorEvent {
  readonly interceptorInputVersion?: string;
  readonly mcp?: {
    readonly gatewayRequest?: {
      readonly headers?: Record<string, string>;
      readonly body?: JsonRpcRequest;
    };
  };
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown>; readonly [k: string]: unknown };
  readonly [k: string]: unknown;
}

export interface ToolInterceptorOutput {
  readonly interceptorOutputVersion: '1.0';
  readonly mcp:
    | { readonly transformedGatewayRequest: { readonly body: unknown } }
    | { readonly transformedGatewayResponse: { readonly statusCode: number; readonly body: unknown } };
}

export interface ToolInterceptorConfig {
  readonly issuer: string;
  readonly ingressRoleArn: string;
  readonly contextKeyId: string;
  readonly contextLifetimeSeconds: number;
}

export interface ToolInterceptorDependencies {
  readonly config: ToolInterceptorConfig;
  /** The ingress JWKS (a remote set in Lambda, a local one in tests). */
  readonly getKey: JWTVerifyGetKey;
  /** Signs the context digest with `ToolContextKey`. */
  readonly contextSigner: DigestSigner;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

class Refusal extends Error {
  constructor(readonly reason: ToolRefusal) {
    super(reason);
  }
}

function pass(body: unknown): ToolInterceptorOutput {
  return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } };
}

/** A refusal the agent sees as a JSON-RPC error with a fixed message (spec §5.4). */
export function refuse(body: JsonRpcRequest | undefined, reason: ToolRefusal): ToolInterceptorOutput {
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        // TODO(v2): confirm against a deployed Gateway that a 403 from the interceptor reaches the client as 403 (the spike answered 200 with a JSON-RPC error).
        statusCode: 403,
        body: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: `forbidden: ${reason}` } },
      },
    },
  };
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
export async function verifyTransactionToken(token: string | undefined, deps: ToolInterceptorDependencies): Promise<ToolCaller> {
  if (token === undefined) {
    throw new Refusal('token_invalid');
  }
  let payload: JWTPayload;
  let typ: string | undefined;
  try {
    const verified = await jwtVerify(token, deps.getKey, {
      issuer: deps.config.issuer,
      audience: TOOLS_GATEWAY_AUDIENCE,
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

/** The interceptor's logic (unit-tested directly). */
export async function interceptTool(event: ToolInterceptorEvent, deps: ToolInterceptorDependencies): Promise<ToolInterceptorOutput> {
  const request = event.mcp?.gatewayRequest;
  const body = request?.body;
  const method = body?.method;
  const gatewayTool = typeof body?.params?.name === 'string' ? body.params.name : undefined;
  const tool = gatewayTool === undefined ? undefined : catalogueToolName(gatewayTool);
  let caller: ToolCaller | undefined;
  try {
    caller = await verifyTransactionToken(bearerToken(headerValue(request?.headers, 'authorization')), deps);
    if (method !== 'tools/call') {
      // tools/list and the protocol methods: verified and logged; Policy filters the list.
      log.info('tools request admitted', { tenantId: caller.tenantId, agent: caller.agent, txn: caller.txn, method: typeof method === 'string' ? method : 'unknown' });
      return pass(body);
    }
    if (tool === undefined || !scopeGrantsTool(caller.scope, tool)) {
      throw new Refusal('tool_not_granted');
    }
    const args: Record<string, unknown> = { ...(body?.params?.arguments ?? {}) };
    const clientContext = CONTEXT_ARGUMENT in args;
    delete args[CONTEXT_ARGUMENT];
    const clientTenant = TENANT_ARGUMENT in args && args[TENANT_ARGUMENT] !== caller.tenantId;
    if (TENANT_ARGUMENT in args) {
      args[TENANT_ARGUMENT] = caller.tenantId;
    }
    const now = Math.floor((deps.now ?? Date.now)() / 1000);
    const context = {
      tenant_id: caller.tenantId,
      sub: caller.sub,
      user: caller.user,
      agent: caller.agent,
      tool,
      argsHash: argsHash(args),
      txn: caller.txn,
      iat: now,
      exp: now + deps.config.contextLifetimeSeconds,
    };
    const signed = await signJws({ alg: 'RS256', typ: CONTEXT_TYPE, kid: deps.config.contextKeyId }, context, deps.contextSigner);
    log.info('tool admitted', {
      tenantId: caller.tenantId,
      user: caller.user,
      agent: caller.agent,
      txn: caller.txn,
      target: tool.split('/')[0],
      tool,
      decision: 'admit',
      clientContextOverwritten: clientContext,
      clientTenantOverwritten: clientTenant,
    });
    return pass({ ...body, params: { ...body?.params, arguments: { ...args, [CONTEXT_ARGUMENT]: signed } } });
  } catch (error) {
    if (error instanceof Refusal) {
      log.warn('tool refused', {
        tenantId: caller?.tenantId,
        user: caller?.user,
        agent: caller?.agent,
        txn: caller?.txn,
        tool,
        decision: 'refuse',
        reason: error.reason,
      });
      return refuse(body, error.reason);
    }
    // KMS or anything unexpected: fail closed with a Gateway error (V-11).
    log.error('tool interceptor failed', { tenantId: caller?.tenantId, tool, error: errorName(error) });
    throw error;
  }
}

function defaultDependencies(): ToolInterceptorDependencies {
  const issuer = requireEnv(TOOLS_ENV.ISSUER);
  const contextKeyId = requireEnv(TOOLS_ENV.CONTEXT_KEY_ID);
  const lifetime = Number(process.env[TOOLS_ENV.CONTEXT_LIFETIME_SECONDS] ?? '60');
  return {
    config: {
      issuer,
      ingressRoleArn: requireEnv(TOOLS_ENV.INGRESS_ROLE_ARN),
      contextKeyId,
      contextLifetimeSeconds: Number.isInteger(lifetime) && lifetime > 0 ? lifetime : 60,
    },
    // jose refetches on an unknown kid, at most once per cooldown (spec §6.2.3: once a minute).
    getKey: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000, cacheMaxAge: 300_000 }),
    contextSigner: kmsDigestSigner(new KMSClient({ requestHandler: sharedHandler() }), contextKeyId, 'RS256'),
  };
}

let deps: ToolInterceptorDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: ToolInterceptorEvent): Promise<ToolInterceptorOutput> {
  deps ??= defaultDependencies();
  return interceptTool(event, deps);
}
