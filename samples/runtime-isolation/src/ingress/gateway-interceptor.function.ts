// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AgentCore Gateway REQUEST interceptor (spec C-3b, ADR-0002, ADR-0013). The
 * Gateway has already checked the JWT with its CUSTOM_JWT authoriser; the
 * interceptor runs the same shared pipeline again (one contract on both
 * ingresses), BUILDS the unit id from the validated claims and the body's
 * `conversationId`, and writes it to the Runtime session header, overwriting
 * whatever the client sent (spike V-3). With the options on it also sets the
 * user-token and credential headers. A refusal is a fixed-text response.
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
import { readIngressConfig } from '../shared/config';
import { errorName, log } from '../shared/logger';
import { emitRequestMetrics } from '../shared/metrics';
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
}

/** Case-insensitive header lookup. */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
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
  // Request side only (see the file comment): Requests, errors and this
  // function's own milliseconds. No backend or model figures exist here.
  const metrics = (status: number, tenantId?: string) =>
    (deps.perTenantMetrics ?? false) &&
    emitRequestMetrics(
      { tenantId: tenantId ?? 'unknown', ingress: 'agentcore-gateway', status, ingressDurationMs: now() - started },
      deps.metricsOut,
    );

  let request;
  try {
    request = await deps.pipeline.validate({
      authorization: header(gatewayRequest?.headers, 'authorization'),
      body: bodyText(gatewayRequest?.body),
    });
  } catch (error) {
    if (error instanceof RequestError) {
      log.warn('request refused', { ingress: 'agentcore-gateway', status: error.status, reason: error.reason, tenantId: error.tenantId });
      metrics(error.status, error.tenantId);
      return deny(error.status);
    }
    log.error('pipeline failed', { ingress: 'agentcore-gateway', error: errorName(error) });
    metrics(502);
    return deny(502);
  }

  log.info('request admitted', {
    ingress: 'agentcore-gateway',
    tenantId: request.tenantId,
    sessionPrefix: prefixOf(request.unitId),
    status: 200,
  });
  metrics(200, request.tenantId);
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
  pipeline.warm();
  // The interceptor never invokes the Runtime itself; the backend object
  // supplies only the header transport. The ARN is not needed for that.
  return { pipeline, backend: new AgentCoreRuntimeBackend(''), perTenantMetrics: config.perTenantMetrics };
}

// Built during init on the Lambda runtime (the config is present there), so
// client construction and the discovery and JWKS fetch run before the first
// event. Under jest the handler is not used; tests call intercept() directly.
let deps: InterceptorDependencies | undefined = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ? defaultDependencies() : undefined;

export async function handler(event: InterceptorEvent): Promise<InterceptorOutput> {
  deps ??= defaultDependencies();
  return intercept(event, deps);
}
