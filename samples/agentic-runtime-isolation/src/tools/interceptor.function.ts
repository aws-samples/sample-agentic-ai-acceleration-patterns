// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tools gateway REQUEST interceptor (spec C-15a, §3.6, P-15; ADR-0034,
 * ADR-0040). It runs BEFORE Policy (spike V-11), so it is the first wall:
 *
 * 1. re-verify the transaction token against the ingress JWKS (cached,
 *    refreshed on an unknown `kid`), with header `typ: txn+jwt` (the Gateway
 *    does not check `typ`, spike V-8), `iss` = the ingress issuer, `aud`
 *    holding `tools-gateway:<this gateway's name>` (ADR-0041) and
 *    `agent:<agent>` for the token's own agent,
 *    `act.sub` = the ingress role, and `exp` in the future;
 * 2. on `tools/call`, check the called tool against `scope`. Policy holds
 *    one star permit per target (ADR-0041), so inside a granted target this
 *    check is the per-tool wall;
 * 3. compute `argsHash` over the arguments (without `_ri_ctx`, after a
 *    client `tenantId` is overwritten with the token's), sign the tenant
 *    context with `ToolContextKey` (KMS `Sign`), and put it in `_ri_ctx`,
 *    overwriting anything the client sent;
 * 4. write one `tool admitted` line per `tools/call` with the tenant and
 *    the gateway (P-9, spec §5.4): `decision: admit`, or `decision: deny`
 *    with the log reason (`scope` for a tool `scope` does not grant) and a
 *    fixed refusal (`forbidden: <reason>`).
 *
 * On `tools/list` it verifies and logs only; Policy filters the list. Any
 * failure is a refusal; none passes the call on, and a throw or timeout is
 * a Gateway 5xx (fail-closed, V-11). It never logs a token or a context
 * value, only names.
 *
 * The body must be ONE JSON-RPC object whose `method` is in
 * `ALLOWED_METHODS`; a JSON-RPC batch (an array), a non-string or unknown
 * method, or a `tools/call` whose `params.arguments` is not a plain object
 * is refused with `malformed_request` (2026-11-04 security review). Without
 * this, such a body would reach the target with the token verified but no
 * per-tool check and no `_ri_ctx`; a Lambda tool fails closed on the
 * missing context, but a target with vendor-shared outbound auth would not.
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { CONTEXT_TYPE } from './context';
import { Refusal, TOOLS_ENV, type ToolCaller, type ToolRefusal, verifyTransactionToken } from './transaction-token';
import { catalogueToolName } from '../shared/cedar';
import { requireEnv, isLambdaRuntime } from '../shared/config';
import { scopeGrantsTool } from '../shared/grant';
import { headerValue } from '../shared/headers';
import { sharedHandler } from '../shared/http';
import { argsHash, CONTEXT_ARGUMENT, type DigestSigner, type JwsAlgorithm, kmsDigestSigner, signJws } from '../shared/jws';
import { errorName, log } from '../shared/logger';
import { bearerToken } from '../shared/verifier';

// Re-exported: the RESPONSE filter and the CDK import them from ./transaction-token,
// which has no load-time side effects (this module builds its dependencies at load).
export { Refusal, TOOLS_ENV, verifyTransactionToken };
export type { TokenVerification, ToolCaller, ToolRefusal } from './transaction-token';

/** The tool argument a client might use to name a tenant; overwritten with the token's (P-15). */
export const TENANT_ARGUMENT = 'tenantId';

/** The JSON-RPC methods the interceptor passes on. Anything else is `malformed_request`. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * The JSON-RPC error code of an interceptor refusal. -32002 is the Gateway's
 * own `insufficient_scope` (spike V-8); the interceptor's refusals use the
 * next server-defined code so an agent can tell the two walls apart.
 */
export const REFUSAL_RPC_CODE = -32003;

/** The `reason` field of the `tool admitted` line (spec §5.4: a tool outside `scope` logs `scope`). */
export function logReason(refusal: ToolRefusal): string {
  return refusal === 'tool_not_granted' ? 'scope' : refusal;
}

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
  /** The algorithm `ToolContextKey` signs with; default `RS256`. */
  readonly contextAlgorithm?: JwsAlgorithm;
  readonly contextLifetimeSeconds: number;
  /** The name of the gateway this interceptor serves (ADR-0041). */
  readonly gatewayName: string;
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


function pass(body: unknown): ToolInterceptorOutput {
  return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } };
}

/**
 * A refusal (spec §5.4): the documented `transformedGatewayResponse` with
 * HTTP 403 and a JSON-RPC error body whose message is the fixed
 * `forbidden: <reason>`, never input. The spike (V-11) saw the Gateway
 * answer an interceptor refusal as HTTP 200 carrying the JSON-RPC error, so
 * the status the agent sees is confirmed by integ step 13; the agent reads
 * the error message either way.
 */
export function refuse(body: JsonRpcRequest | undefined, reason: ToolRefusal): ToolInterceptorOutput {
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: 403,
        body: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: REFUSAL_RPC_CODE, message: `forbidden: ${reason}` } },
      },
    },
  };
}


/** The interceptor's logic (unit-tested directly). */
export async function interceptTool(event: ToolInterceptorEvent, deps: ToolInterceptorDependencies): Promise<ToolInterceptorOutput> {
  const request = event.mcp?.gatewayRequest;
  const rawBody: unknown = request?.body;
  const body: JsonRpcRequest | undefined = isPlainObject(rawBody) ? (rawBody as JsonRpcRequest) : undefined;
  const method = body?.method;
  const gatewayTool = typeof body?.params?.name === 'string' ? body.params.name : undefined;
  const tool = gatewayTool === undefined ? undefined : catalogueToolName(gatewayTool);
  let caller: ToolCaller | undefined;
  try {
    caller = await verifyTransactionToken(bearerToken(headerValue(request?.headers, 'authorization')), deps);
    // One JSON-RPC object with a known method, else refused: a batch array or an
    // unknown method would otherwise pass with no per-tool check and no context.
    if (body === undefined || typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      throw new Refusal('malformed_request');
    }
    if (method !== 'tools/call') {
      // tools/list and the protocol methods: verified and logged; Policy filters the list.
      log.info('tools request admitted', {
        tenantId: caller.tenantId,
        agent: caller.agent,
        txn: caller.txn,
        gateway: deps.config.gatewayName,
        method,
      });
      return pass(body);
    }
    if (tool === undefined || !scopeGrantsTool(caller.scope, tool)) {
      throw new Refusal('tool_not_granted');
    }
    const rawArgs: unknown = body.params?.arguments;
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      throw new Refusal('malformed_request'); // never sign a context over a shape the tool will not read
    }
    const args: Record<string, unknown> = { ...((rawArgs as Record<string, unknown> | undefined) ?? {}) };
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
    const signed = await signJws({ alg: deps.config.contextAlgorithm ?? 'RS256', typ: CONTEXT_TYPE, kid: deps.config.contextKeyId }, context, deps.contextSigner);
    log.info('tool admitted', {
      tenantId: caller.tenantId,
      user: caller.user,
      agent: caller.agent,
      chain: caller.chain.length === 0 ? undefined : caller.chain.join(','),
      txn: caller.txn,
      gateway: deps.config.gatewayName,
      target: tool.split('/')[0],
      tool,
      decision: 'admit',
      clientContextOverwritten: clientContext,
      clientTenantOverwritten: clientTenant,
    });
    return pass({ ...body, params: { ...body.params, arguments: { ...args, [CONTEXT_ARGUMENT]: signed } } });
  } catch (error) {
    if (error instanceof Refusal) {
      log.warn(method === 'tools/call' ? 'tool admitted' : 'tools request refused', {
        tenantId: caller?.tenantId,
        user: caller?.user,
        agent: caller?.agent,
        txn: caller?.txn,
        gateway: deps.config.gatewayName,
        target: tool?.split('/')[0],
        tool,
        decision: 'deny',
        reason: logReason(error.reason),
        refusal: error.reason,
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
  const contextAlgorithm = process.env[TOOLS_ENV.CONTEXT_ALGORITHM] ?? 'RS256';
  if (contextAlgorithm !== 'RS256' && contextAlgorithm !== 'ES256') {
    throw new Error(`${TOOLS_ENV.CONTEXT_ALGORITHM} must be RS256 or ES256`);
  }
  return {
    config: {
      issuer,
      ingressRoleArn: requireEnv(TOOLS_ENV.INGRESS_ROLE_ARN),
      contextKeyId,
      contextAlgorithm,
      contextLifetimeSeconds: Number.isInteger(lifetime) && lifetime > 0 ? lifetime : 60,
      gatewayName: requireEnv(TOOLS_ENV.GATEWAY_NAME),
    },
    // jose refetches on an unknown kid, at most once per cooldown (spec §6.2.3: once a minute).
    getKey: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000, cacheMaxAge: 300_000 }),
    contextSigner: kmsDigestSigner(new KMSClient({ requestHandler: sharedHandler() }), contextKeyId, contextAlgorithm),
  };
}

let deps: ToolInterceptorDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: ToolInterceptorEvent): Promise<ToolInterceptorOutput> {
  deps ??= defaultDependencies();
  return interceptTool(event, deps);
}
