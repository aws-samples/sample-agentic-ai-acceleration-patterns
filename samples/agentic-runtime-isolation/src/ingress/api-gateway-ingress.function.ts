// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * API Gateway streaming integration Lambda (spec C-3a). Runs the shared
 * pipeline (verify, resolve the route's backend through the registry, parse,
 * choose the unit, optional token and credentials), invokes the resolved
 * Runtime with SigV4 and relays its stream to the caller through Lambda
 * response streaming (spike V-5: the integration timeout is two minutes, set
 * by the construct). One Lambda serves every backend behind the ingress
 * (ADR-0024); no Runtime ARN is in its environment. Logs carry the verified
 * tenantId, the backend and the session prefix as fields, never a header
 * value (P-9); one EMF record per request carries requests, 4xx/5xx, TTFB
 * and streamed bytes (P-9) and the cost meters (P-10, ADR-0017): ingress
 * milliseconds, backend invoke seconds (from the invoke call to the end of
 * the stream), and the model tokens read from the agent's final
 * `event: usage` SSE event. The stream is forwarded unchanged; the scanner
 * only looks at it.
 */

import type { Writable } from 'node:stream';
import type { APIGatewayProxyEvent, StreamifyHandler } from 'aws-lambda';
import { AgentCoreRuntimeBackend } from '../backend/agentcore-runtime.transport';
import type { InvokeBackend } from '../backend/backend';
import { isLambdaRuntime, readIngressConfig } from '../shared/config';
import { headerValue } from '../shared/headers';
import { errorName, log } from '../shared/logger';
import { emitRequestMetrics, type RequestMetrics, UsageEventScanner } from '../shared/metrics';
import { type AuthorizedContext, errorBody, type ErrorStatus, IngressPipeline, pipelineFor, RequestError } from '../shared/request';
import { prefixOf } from '../shared/session';
import { TENANT_HEADER } from '../shared/tenant';

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
  /** Emit per-tenant EMF metrics (ADR-0021). Default false. */
  readonly perTenantMetrics?: boolean;
  /** Resolves once init's pre-connects are done (ADR-0023); the first request awaits it. */
  readonly ready?: Promise<void>;
}

/**
 * (v2) The authoriser's decision and transaction token from its context
 * (spec §3.1 C-3a), or undefined when the context lacks any of them.
 */
export function authorizedContext(authorizer: Record<string, unknown>): AuthorizedContext | undefined {
  const { tenantId, backend, transactionToken, txn, grantSize, mint } = authorizer;
  if (
    typeof tenantId !== 'string' ||
    typeof backend !== 'string' ||
    typeof transactionToken !== 'string' ||
    transactionToken.length === 0 ||
    typeof txn !== 'string' ||
    (mint !== 'hit' && mint !== 'miss')
  ) {
    return undefined;
  }
  const size = Number(grantSize);
  return { tenantId, backend, transactionToken, txn, grantSize: Number.isInteger(size) ? size : 0, mint };
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
  // The first request of an environment waits for init's pre-connects and
  // fetches (ADR-0023); afterwards this is a settled promise. `ready` never
  // rejects by construction (warm() swallows failures), so no catch here.
  await deps.ready;
  // The tenant and backend the authoriser resolved: present on every request
  // that reached us, so even a refusal below is attributed in the metrics.
  const authorizer = (event.requestContext?.authorizer ?? {}) as Record<string, unknown>;
  const authorizedTenant = typeof authorizer.tenantId === 'string' ? authorizer.tenantId : undefined;
  const authorizedBackend = typeof authorizer.backend === 'string' ? authorizer.backend : undefined;
  type Extra = Omit<RequestMetrics, 'tenantId' | 'ingress' | 'status' | 'ingressDurationMs'>;
  // One EMF record per request, emitted once, at the end, so IngressDurationMs
  // covers the whole handler (P-10).
  // Per-tenant EMF metrics are opt-in (ADR-0021): the log line below carries
  // the same figures with the tenantId at no per-tenant metric cost.
  const metricsOn = deps.perTenantMetrics ?? false;
  const tenantForMetrics = (status: number, tenantId?: string, extra: Extra = {}) =>
    metricsOn &&
    emitRequestMetrics(
      {
        tenantId: tenantId ?? authorizedTenant ?? 'unknown',
        ingress: 'api-gateway',
        status,
        ingressDurationMs: now() - started,
        backend: authorizedBackend,
        ...extra,
      },
      deps.metricsOut,
    );

  const fail = (status: ErrorStatus, reason: string, tenantId?: string, backend: string | undefined = authorizedBackend) => {
    log.warn('request refused', { ingress: 'api-gateway', status, reason, tenantId, backend });
    tenantForMetrics(status, tenantId, { backend });
    out.start(status, { 'Content-Type': 'text/plain' });
    out.write(errorBody(status, reason));
    out.end();
  };

  let request;
  try {
    // `event.path` is the request path as called, stage stripped
    // (`/<backend>/invocations`): the real segment the client sent, where
    // `requestContext.resourcePath` is the template (`/{backend}/invocations`)
    // and `requestContext.path` carries the stage prefix. The registry
    // resolves the name (ADR-0024).
    // (v2) The authoriser minted the transaction token; this Lambda forwards
    // it after checking it is for the tenant and backend it verified itself.
    // Without one in the context the pipeline refuses with 502 mint_failed.
    request = await deps.pipeline.validate({
      authorization: headerValue(event.headers, 'authorization'),
      tenantHeader: headerValue(event.headers, TENANT_HEADER),
      body: decodeBody(event),
      path: event.path,
      authorized: authorizedContext(authorizer),
    });
  } catch (error) {
    if (error instanceof RequestError) {
      return fail(error.status, error.reason, error.tenantId);
    }
    log.error('pipeline failed', { ingress: 'api-gateway', error: errorName(error) });
    return fail(502, 'pipeline_failed');
  }

  // P-9 (v2): `agent`, `txn`, `grantSize` and `mint` join this line to the
  // tools gateway's `tool admitted` lines; never the token itself.
  const fields = {
    ingress: 'api-gateway',
    tenantId: request.tenantId,
    backend: request.backend,
    agent: request.backend,
    txn: request.txn,
    grantSize: request.grantSize,
    mint: request.mint,
    sessionPrefix: prefixOf(request.unitId),
    // ADR-0048: set on the delegation route; the token's `txn` above is the caller's.
    delegatedFrom: request.delegatedFrom,
    depth: request.depth,
  };
  // Backend invoke wall time runs from the invoke call to the end of the
  // stream: the AgentCore Runtime bills the session's active CPU and memory
  // over that window (P-10).
  const invokeStarted = now();
  let response;
  try {
    response = await deps.backend.invoke(request);
  } catch (error) {
    log.error('backend invoke failed', { ...fields, error: errorName(error) });
    return fail(502, 'backend_failed', request.tenantId, request.backend);
  }

  let ttfbMs: number | undefined;
  let streamedBytes = 0;
  // Reads the usage event off the stream as it passes; the chunks the caller
  // receives are the chunks the backend sent (ADR-0017).
  const usage = new UsageEventScanner();
  out.start(200, { 'Content-Type': response.contentType, 'Cache-Control': 'no-store' });
  try {
    for await (const chunk of response.body) {
      if (ttfbMs === undefined) {
        ttfbMs = now() - started;
      }
      streamedBytes += chunk.byteLength;
      usage.feed(chunk);
      out.write(chunk);
    }
  } catch (error) {
    // The status is already on the wire; log the break and end the stream.
    log.error('stream interrupted', { ...fields, error: errorName(error), streamedBytes });
  } finally {
    out.end();
  }
  const backendInvokeSeconds = (now() - invokeStarted) / 1000;
  const reported = usage.result();
  // Figures only: the token counts and the model id, never stream content.
  // (The logger drops any field whose name contains "token", a guard for
  // bearer tokens, so the counts are logged as usageInput/usageOutput.)
  log.info('request served', {
    ...fields,
    status: 200,
    ttfbMs,
    streamedBytes,
    backendInvokeSeconds,
    usageInput: reported?.inputTokens,
    usageOutput: reported?.outputTokens,
    modelId: reported?.modelId,
    usageReported: reported !== undefined,
    totalMs: now() - started,
  });
  // ADR-0020: the tokens this request used count against the tenant's next requests.
  if (reported !== undefined) {
    await deps.pipeline.limiter?.recordOutputTokens(request.tenantId, reported.outputTokens);
  }
  tenantForMetrics(200, request.tenantId, {
    backend: request.backend,
    ttfbMs,
    streamedBytes,
    backendInvokeSeconds,
    modelInputTokens: reported?.inputTokens,
    modelOutputTokens: reported?.outputTokens,
  });
}

// ---------------------------------------------------------------------------
// Lambda entry point. Dependencies are built at cold start; the streaming
// global is optional so the module also loads under jest.
// ---------------------------------------------------------------------------

function defaultDependencies(): HandlerDependencies {
  const config = readIngressConfig();
  const pipeline = pipelineFor(config);
  // One transport for every backend: the Runtime ARN comes with each
  // validated request from the registry (ADR-0024).
  const backend = new AgentCoreRuntimeBackend();
  // The connections to STS, DynamoDB and the Runtime endpoint open during
  // init, in parallel with the verifier's fetches and the default backend's
  // registry read (ADR-0023).
  const ready = Promise.all([pipeline.warm(), backend.warm()]).then(() => undefined);
  return { pipeline, backend, perTenantMetrics: config.perTenantMetrics, ready };
}

type StreamHandler = StreamifyHandler<APIGatewayProxyEvent, void>;

// `awslambda` is a global of the Lambda Node.js runtime (typed by
// @types/aws-lambda); under jest it is absent, so the handler is exported
// unwrapped and the tests call handleRequest directly.
const onLambda = typeof awslambda !== 'undefined' && typeof awslambda.streamifyResponse === 'function';
const streamify: (fn: StreamHandler) => StreamHandler = onLambda ? (fn) => awslambda.streamifyResponse(fn) : (fn) => fn;

// Built during init on the Lambda runtime: the config read, the SDK clients
// and the TVM cache are constructed at boosted CPU, and the verifier's
// discovery and JWKS fetch run before the first event arrives. A missing or
// malformed environment variable therefore fails init, naming it, rather
// than the first request (intended: the construct sets every variable).
// Under jest there is no config, so the handler builds them on first call.
let deps: HandlerDependencies | undefined = isLambdaRuntime() ? defaultDependencies() : undefined;

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
