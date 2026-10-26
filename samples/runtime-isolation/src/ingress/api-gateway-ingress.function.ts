// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * API Gateway streaming integration Lambda (spec C-3a). Runs the shared
 * pipeline (verify, parse, choose the unit, optional token and credentials),
 * invokes the backend with SigV4 and relays its stream to the caller through
 * Lambda response streaming (spike V-5: the integration timeout is two
 * minutes, set by the construct). Logs carry the verified tenantId and the
 * session prefix as fields, never a header value (P-9); one EMF record per
 * request carries requests, 4xx/5xx, TTFB and streamed bytes.
 */

import type { Writable } from 'node:stream';
import type { APIGatewayProxyEvent, StreamifyHandler } from 'aws-lambda';
import { AgentCoreRuntimeBackend } from '../backend/agentcore-runtime.transport';
import type { InvokeBackend } from '../backend/backend';
import { ENV, readIngressConfig, requireEnv } from '../shared/config';
import { errorName, log } from '../shared/logger';
import { emitRequestMetrics } from '../shared/metrics';
import { ERROR_TEXT, IngressPipeline, pipelineFor, RequestError } from '../shared/request';
import { prefixOf } from '../shared/session';

/** What the handler needs from the response stream; the Lambda global supplies it. */
export interface ResponseWriter {
  start(statusCode: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array | string): void;
  end(): void;
}

export interface HandlerDependencies {
  readonly pipeline: IngressPipeline;
  readonly backend: InvokeBackend;
  readonly now?: () => number;
  readonly metricsOut?: (line: string) => void;
}

function authorizationHeader(event: APIGatewayProxyEvent): string | undefined {
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (name.toLowerCase() === 'authorization' && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function decodeBody(event: APIGatewayProxyEvent): string | null {
  if (event.body === null || event.body === undefined) {
    return null;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** The handler's logic, independent of the Lambda streaming global (unit-tested directly). */
export async function handleRequest(event: APIGatewayProxyEvent, out: ResponseWriter, deps: HandlerDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const started = now();
  // The tenant the authoriser verified: present on every request that reached
  // us, so even a refusal below is attributed to a tenant in the metrics.
  const authorizedTenant = (event.requestContext?.authorizer as Record<string, unknown> | undefined)?.tenantId;
  const tenantForMetrics = (status: number, tenantId?: string, extra: { ttfbMs?: number; streamedBytes?: number } = {}) =>
    emitRequestMetrics(
      { tenantId: tenantId ?? (typeof authorizedTenant === 'string' ? authorizedTenant : 'unknown'), ingress: 'api-gateway', status, ...extra },
      deps.metricsOut,
    );

  const fail = (status: 400 | 401 | 403 | 502, reason: string, tenantId?: string) => {
    log.warn('request refused', { ingress: 'api-gateway', status, reason, tenantId });
    tenantForMetrics(status, tenantId);
    out.start(status, { 'Content-Type': 'text/plain' });
    out.write(ERROR_TEXT[status]);
    out.end();
  };

  let request;
  try {
    request = await deps.pipeline.validate({ authorization: authorizationHeader(event), body: decodeBody(event) });
  } catch (error) {
    if (error instanceof RequestError) {
      return fail(error.status, error.reason);
    }
    log.error('pipeline failed', { ingress: 'api-gateway', error: errorName(error) });
    return fail(502, 'pipeline_failed');
  }

  const fields = { ingress: 'api-gateway', tenantId: request.tenantId, sessionPrefix: prefixOf(request.unitId) };
  let response;
  try {
    response = await deps.backend.invoke(request);
  } catch (error) {
    log.error('backend invoke failed', { ...fields, error: errorName(error) });
    return fail(502, 'backend_failed', request.tenantId);
  }

  let ttfbMs: number | undefined;
  let streamedBytes = 0;
  out.start(200, { 'Content-Type': response.contentType, 'Cache-Control': 'no-store' });
  try {
    for await (const chunk of response.body) {
      if (ttfbMs === undefined) {
        ttfbMs = now() - started;
      }
      streamedBytes += chunk.byteLength;
      out.write(chunk);
    }
  } catch (error) {
    // The status is already on the wire; log the break and end the stream.
    log.error('stream interrupted', { ...fields, error: errorName(error), streamedBytes });
  } finally {
    out.end();
  }
  log.info('request served', { ...fields, status: 200, ttfbMs, streamedBytes, totalMs: now() - started });
  tenantForMetrics(200, request.tenantId, { ttfbMs, streamedBytes });
}

// ---------------------------------------------------------------------------
// Lambda entry point. Dependencies are built at cold start; the streaming
// global is optional so the module also loads under jest.
// ---------------------------------------------------------------------------

function defaultDependencies(): HandlerDependencies {
  const config = readIngressConfig();
  return {
    pipeline: pipelineFor(config),
    backend: new AgentCoreRuntimeBackend(requireEnv(ENV.RUNTIME_ARN)),
  };
}

type StreamHandler = StreamifyHandler<APIGatewayProxyEvent, void>;

// `awslambda` is a global of the Lambda Node.js runtime (typed by
// @types/aws-lambda); under jest it is absent, so the handler is exported
// unwrapped and the tests call handleRequest directly.
const streamify: (fn: StreamHandler) => StreamHandler =
  typeof awslambda !== 'undefined' && typeof awslambda.streamifyResponse === 'function'
    ? (fn) => awslambda.streamifyResponse(fn)
    : (fn) => fn;

let deps: HandlerDependencies | undefined;

export const handler: StreamHandler = streamify(async (event, responseStream) => {
  deps ??= defaultDependencies();
  let stream: Writable | undefined;
  const writer: ResponseWriter = {
    start: (statusCode, headers) => {
      stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
    },
    write: (chunk) => {
      stream?.write(chunk);
    },
    end: () => {
      (stream ?? responseStream).end();
    },
  };
  await handleRequest(event, writer, deps);
});
