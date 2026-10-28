// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AgentCore Gateway REQUEST interceptor (spec C-3b, ADR-0002, ADR-0013,
 * ADR-0024). The Gateway has already checked the JWT with its CUSTOM_JWT
 * authoriser (`allowedScopes` is the product floor); the interceptor runs the
 * same shared pipeline again (one contract on both ingresses), resolves the
 * backend the Gateway target names through the registry and requires its
 * scopes, BUILDS the unit id from the validated claims and the body's
 * `conversationId`, and writes it to the Runtime session header, overwriting
 * whatever the client sent (spike V-3). With the options on it also sets the
 * user-token and credential headers. A refusal is a fixed-text response.
 *
 * The Gateway target is created under the backend's name (`AgentBackend`), so
 * the request path the interceptor event carries is `/<backend>/invocations`
 * (verified: integ step 9-registry, 2026-10-28) and the same `backendFromPath`
 * reads it on both ingresses. On this ingress the name MUST come from the
 * path: the pipeline is called with `requireBackendInPath`, so a default
 * backend never routes a Gateway request, and an event whose path names no
 * backend is refused with 404 `unknown_backend`. That case is a deployment
 * fault (a target not named after its backend), so this module warns once
 * per cold start to make it visible in the logs.
 *
 * Logs carry header NAMES never, and values never: only the verified
 * tenantId, the session prefix, a status and a reason (P-9, spike V-7).
 *
 * Cost metering (P-10, ADR-0017) on this ingress is request-side only. A
 * REQUEST interceptor returns before the Gateway invokes the Runtime and
 * never sees the response, so it can emit `Requests`, the errors and
 * `IngressDurationMs` (its own wall time) but NOT `BackendInvokeSeconds`,
 * `ModelInputTokens`, `ModelOutputTokens`, `TtfbMs` or `StreamedBytes`.
 * Those stay absent from this ingress's records rather than being guessed;
 * a RESPONSE interceptor would see the body but not the invoke wall time.
 * This is an input to the ingress comparison (ADR-0009).
 */

import { AgentCoreRuntimeBackend } from '../backend/agentcore-runtime.transport';
import type { HeaderTransportBackend } from '../backend/backend';
import { isLambdaRuntime, readIngressConfig } from '../shared/config';
import { headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { emitRequestMetrics } from '../shared/metrics';
import { backendFromPath } from '../shared/registry';
import { ERROR_TEXT, type ErrorStatus, IngressPipeline, pipelineFor, RequestError } from '../shared/request';
import { prefixOf } from '../shared/session';

/** The REQUEST interceptor event for an HTTP (Runtime) target, as the spike observed it. */
export interface InterceptorEvent {
  readonly interceptorInputVersion?: string;
  readonly http?: {
    readonly gatewayRequest?: {
      readonly path?: string;
      readonly headers?: Record<string, string>;
      readonly body?: unknown;
    };
  };
}

export interface InterceptorOutput {
  readonly interceptorOutputVersion: '1.0';
  readonly http:
    | { readonly transformedGatewayRequest: { readonly headers: Record<string, string>; readonly body?: unknown } }
    | { readonly transformedGatewayResponse: { readonly statusCode: number; readonly contentType: string; readonly body: string } };
}

export interface InterceptorDependencies {
  readonly pipeline: IngressPipeline;
  readonly backend: HeaderTransportBackend;
  readonly metricsOut?: (line: string) => void;
  /** Emit per-tenant EMF metrics (ADR-0021). Default false. */
  readonly perTenantMetrics?: boolean;
  readonly now?: () => number;
  /** Resolves once init's pre-connects are done (ADR-0023); the first request awaits it. */
  readonly ready?: Promise<void>;
}

/**
 * The body as a JSON string for the pipeline. The Gateway may hand the body
 * as a string, as base64, or as an already-parsed object; the pipeline parses
 * one shape.
 */
export function bodyText(body: unknown): string | null {
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === 'object') {
    return JSON.stringify(body);
  }
  if (typeof body !== 'string') {
    return null;
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  try {
    return Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    return trimmed;
  }
}

/** Set once the 'interceptor path lacks backend' warning has been written in this process. */
let warnedPathLacksBackend = false;

/** Resets the once-per-cold-start warning (tests only). */
export function resetPathWarning(): void {
  warnedPathLacksBackend = false;
}

function deny(statusCode: ErrorStatus): InterceptorOutput {
  return {
    interceptorOutputVersion: '1.0',
    http: {
      transformedGatewayResponse: {
        statusCode,
        contentType: 'text/plain',
        body: Buffer.from(ERROR_TEXT[statusCode], 'utf8').toString('base64'),
      },
    },
  };
}

/** The interceptor's logic (unit-tested directly). */
export async function intercept(event: InterceptorEvent, deps: InterceptorDependencies): Promise<InterceptorOutput> {
  const gatewayRequest = event.http?.gatewayRequest;
  const now = deps.now ?? Date.now;
  const started = now();
  // The first request of an environment waits for init's pre-connects and
  // fetches (ADR-0023); `ready` never rejects by construction.
  await deps.ready;
  // Request side only (see the file comment): Requests, errors and this
  // function's own milliseconds. No backend or model figures exist here.
  const metrics = (status: number, tenantId?: string, backend?: string) =>
    (deps.perTenantMetrics ?? false) &&
    emitRequestMetrics(
      { tenantId: tenantId ?? 'unknown', ingress: 'agentcore-gateway', status, ingressDurationMs: now() - started, backend },
      deps.metricsOut,
    );

  // The Gateway target is named after the backend, so the request path the
  // event carries is `/<backend>/invocations`; the registry resolves it
  // (ADR-0024). The name is read from the path only, never from a header,
  // and never from the default backend (`requireBackendInPath`).
  const path = gatewayRequest?.path;
  const backend = backendFromPath(path);
  let request;
  try {
    request = await deps.pipeline.validate({
      authorization: headerValue(gatewayRequest?.headers, 'authorization'),
      body: bodyText(gatewayRequest?.body),
      path,
      requireBackendInPath: true,
    });
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.reason === 'unknown_backend' && backend === undefined && !warnedPathLacksBackend) {
        // The event named no backend: the target is not named after its
        // backend, or the Gateway handed a path this module does not read.
        warnedPathLacksBackend = true;
        log.warn('interceptor path lacks backend', { ingress: 'agentcore-gateway', pathPresent: path !== undefined });
      }
      log.warn('request refused', { ingress: 'agentcore-gateway', status: error.status, reason: error.reason, tenantId: error.tenantId, backend });
      metrics(error.status, error.tenantId, backend);
      return deny(error.status);
    }
    log.error('pipeline failed', { ingress: 'agentcore-gateway', error: errorName(error) });
    metrics(502);
    return deny(502);
  }

  log.info('request admitted', {
    ingress: 'agentcore-gateway',
    tenantId: request.tenantId,
    backend: request.backend,
    sessionPrefix: prefixOf(request.unitId),
    status: 200,
  });
  metrics(200, request.tenantId, request.backend);
  // The body passes through unchanged; the agent reads `prompt` and ignores
  // the rest. Every header the backend needs is set here, so a client value
  // in the session header never reaches the Runtime (P-2).
  return {
    interceptorOutputVersion: '1.0',
    http: {
      transformedGatewayRequest: {
        headers: deps.backend.transportHeaders(request),
        body: gatewayRequest?.body,
      },
    },
  };
}

function defaultDependencies(): InterceptorDependencies {
  const config = readIngressConfig();
  const pipeline = pipelineFor(config);
  // STS and DynamoDB connections and the default backend's registry read
  // happen during init (ADR-0023). The interceptor never invokes the Runtime
  // itself; the backend object supplies only the header transport, so no
  // Runtime client or connection is built here.
  const ready = pipeline.warm();
  return { pipeline, backend: new AgentCoreRuntimeBackend(), perTenantMetrics: config.perTenantMetrics, ready };
}

// Built during init on the Lambda runtime (the config is present there), so
// client construction and the discovery and JWKS fetch run before the first
// event; a missing or malformed variable fails init, naming it (intended).
// Under jest the handler is not used; tests call intercept() directly.
let deps: InterceptorDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

export async function handler(event: InterceptorEvent): Promise<InterceptorOutput> {
  deps ??= defaultDependencies();
  return intercept(event, deps);
}
