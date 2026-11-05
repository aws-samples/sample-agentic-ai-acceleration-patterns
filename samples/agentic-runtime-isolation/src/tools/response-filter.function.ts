// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tools gateway RESPONSE interceptor (spec §3.3 `responseFilter`, §3.6;
 * ADR-0041). Off by default; on a gateway with `responseFilter: true` it
 * trims each `tools/list` page to the exact tools the caller's `scope`
 * grants. Policy holds one star permit per target, so without this filter a
 * caller granted `crm/get_account` lists every `crm` tool (and still cannot
 * call the others: the REQUEST interceptor refuses them).
 *
 * - It reads the transaction token from the request headers the Gateway
 *   passes (`passRequestHeaders: true`) and verifies it exactly as the
 *   REQUEST interceptor does (signature, `typ`, `iss`, `aud` holding
 *   `tools-gateway:<this gateway>` and the agent, `act.sub`).
 * - It acts on `tools/list` responses only; every other response passes
 *   unchanged.
 * - It only removes: a tool stays when its `<target>/<tool>` is granted by
 *   `scope` (`<target>/*` expanded), and anything that is not a catalogue
 *   tool name is removed. It never adds a tool.
 * - On any error (no or bad token, an unreadable page) it answers the page
 *   with an empty `tools` array and logs `response_filter_failed`:
 *   fail-closed. It logs names and counts, never a token.
 *
 * Event shape: the AgentCore Gateway documentation's RESPONSE input,
 * `mcp.gatewayRequest` (headers present with `passRequestHeaders`) and
 * `mcp.gatewayResponse` `{ statusCode, headers, body }`.
 * The shape is the documented one; integ step 24 confirms on a deployed
 * Gateway that `gatewayRequest.headers` reaches a RESPONSE interceptor
 * configured with `passRequestHeaders: true` (a missing header makes every
 * filtered page empty, which step 24 reports as a shape failure, not a
 * design one) and how a streamed (`isStreamingResponse`) `tools/list`
 * arrives. If the headers do not arrive, the REQUEST interceptor must carry
 * the verified scope to this one (for example in a signed `_meta` value).
 *
 * With `RI_RESPONSE_FILTER_FORCE_ERROR=true` in its environment the filter
 * fails every listing (integ step 24 sets it on the test stacks to show the
 * fail-closed page). The switch can only remove tools, never add one.
 */

import { createRemoteJWKSet } from 'jose';
import { type TokenVerification, TOOLS_ENV, verifyTransactionToken } from './transaction-token';
import { catalogueToolName } from '../shared/cedar';
import { isLambdaRuntime, requireEnv } from '../shared/config';
import { scopeGrantsTool } from '../shared/grant';
import { headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { bearerToken } from '../shared/verifier';

/** Set to `true` to make the filter fail every listing (fail-closed test, integ step 24). */
export const RESPONSE_FILTER_FORCE_ERROR_ENV = 'RI_RESPONSE_FILTER_FORCE_ERROR';

/** The MCP RESPONSE interceptor event (AgentCore Gateway documentation). */
export interface ToolResponseEvent {
  readonly interceptorInputVersion?: string;
  readonly mcp?: {
    readonly gatewayRequest?: {
      readonly headers?: Record<string, string>;
      readonly body?: { readonly id?: string | number | null; readonly method?: string; readonly [k: string]: unknown };
    };
    readonly gatewayResponse?: {
      readonly statusCode?: number;
      readonly headers?: Record<string, string>;
      readonly isStreamingResponse?: boolean;
      readonly body?: unknown;
    };
  };
}

export interface ToolResponseOutput {
  readonly interceptorOutputVersion: '1.0';
  readonly mcp: { readonly transformedGatewayResponse: { readonly statusCode: number; readonly body: unknown } };
}

interface JsonRpcListResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: { readonly tools?: unknown; readonly [k: string]: unknown };
  readonly [k: string]: unknown;
}

function respond(statusCode: number, body: unknown): ToolResponseOutput {
  return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayResponse: { statusCode, body } } };
}

/** The fail-closed page: the same JSON-RPC id, no tools. */
function emptyPage(id: string | number | null | undefined): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: { tools: [] } };
}

/** The filter's logic (unit-tested directly). */
export async function filterToolsResponse(
  event: ToolResponseEvent,
  deps: TokenVerification,
  options: { readonly forceError?: boolean } = {},
): Promise<ToolResponseOutput> {
  const request = event.mcp?.gatewayRequest;
  const response = event.mcp?.gatewayResponse;
  const statusCode = typeof response?.statusCode === 'number' ? response.statusCode : 200;
  if (request?.body?.method !== 'tools/list') {
    // Not a listing: unchanged.
    return respond(statusCode, response?.body);
  }
  const id = request.body.id;
  let tenantId: string | undefined;
  try {
    const caller = await verifyTransactionToken(bearerToken(headerValue(request.headers, 'authorization')), deps);
    tenantId = caller.tenantId;
    if (options.forceError === true) {
      throw Object.assign(new Error('forced'), { name: 'ForcedFilterError' });
    }
    const body = response?.body as JsonRpcListResponse | undefined;
    if (body === undefined || typeof body !== 'object' || body === null) {
      throw new Error('unreadable page');
    }
    if (body.result === undefined) {
      // A JSON-RPC error from the Gateway: nothing to filter, nothing to leak.
      return respond(statusCode, body);
    }
    if (!Array.isArray(body.result.tools)) {
      throw new Error('page has no tools array');
    }
    const listed = body.result.tools as unknown[];
    const kept = listed.filter((tool) => {
      const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : undefined;
      const catalogueName = typeof name === 'string' ? catalogueToolName(name) : undefined;
      return catalogueName !== undefined && scopeGrantsTool(caller.scope, catalogueName);
    });
    log.info('tools list filtered', { tenantId, agent: caller.agent, txn: caller.txn, listed: listed.length, kept: kept.length });
    return respond(statusCode, { ...body, result: { ...body.result, tools: kept } });
  } catch (error) {
    log.warn('response_filter_failed', { tenantId, error: errorName(error) });
    return respond(statusCode >= 200 && statusCode < 300 ? statusCode : 200, emptyPage(id));
  }
}

function defaultDependencies(): TokenVerification {
  const issuer = requireEnv(TOOLS_ENV.ISSUER);
  return {
    config: { issuer, ingressRoleArn: requireEnv(TOOLS_ENV.INGRESS_ROLE_ARN), gatewayName: requireEnv(TOOLS_ENV.GATEWAY_NAME) },
    getKey: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000, cacheMaxAge: 300_000 }),
  };
}

let deps: TokenVerification | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: ToolResponseEvent): Promise<ToolResponseOutput> {
  deps ??= defaultDependencies();
  return filterToolsResponse(event, deps, { forceError: process.env[RESPONSE_FILTER_FORCE_ERROR_ENV] === 'true' });
}
