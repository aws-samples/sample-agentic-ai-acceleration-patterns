// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant metrics as CloudWatch embedded metric format (P-9, P-10,
 * standard §4.4, ADR-0017): one EMF record per request with the verified
 * tenant as a dimension. Written straight to stdout, not through
 * console.log, because the Lambda JSON log format wraps console output and
 * CloudWatch then no longer recognises the record as EMF.
 *
 * The P-10 cost metrics meter what each pooled service bills for: ingress
 * requests and milliseconds, backend invocation seconds (wall time of the
 * invoke, the AgentCore Runtime billing unit together with memory), model
 * input and output tokens, and streamed bytes. Tokens come from the agent's
 * final `event: usage` SSE event, which this module parses; the ingress reads
 * the figures and never stores the content.
 */

/** The ingress that served the request; the second EMF dimension. */
export type IngressKind = 'api-gateway' | 'agentcore-gateway';

export const METRICS_NAMESPACE = 'RuntimeIsolation';

/** The metric names, in the order they appear in the record. */
export const METRIC_NAMES = {
  Requests: 'Requests',
  Errors4xx: 'Errors4xx',
  Errors5xx: 'Errors5xx',
  IngressDurationMs: 'IngressDurationMs',
  TtfbMs: 'TtfbMs',
  BackendInvokeSeconds: 'BackendInvokeSeconds',
  StreamedBytes: 'StreamedBytes',
  ModelInputTokens: 'ModelInputTokens',
  ModelOutputTokens: 'ModelOutputTokens',
} as const;

/** The six P-10 cost metrics (ADR-0017); the demo dashboard shows these per tenant. */
export const COST_METRIC_NAMES = [
  METRIC_NAMES.Requests,
  METRIC_NAMES.IngressDurationMs,
  METRIC_NAMES.BackendInvokeSeconds,
  METRIC_NAMES.ModelInputTokens,
  METRIC_NAMES.ModelOutputTokens,
  METRIC_NAMES.StreamedBytes,
] as const;

export interface RequestMetrics {
  /** The verified `tenant_id`; a dimension, never free text. */
  readonly tenantId: string;
  readonly ingress: IngressKind;
  /** HTTP status the ingress returned. */
  readonly status: number;
  /** Wall time of the ingress handler for this request, in milliseconds. */
  readonly ingressDurationMs?: number;
  /** Time to first byte from the backend, in milliseconds, when a call was made. */
  readonly ttfbMs?: number;
  /** Wall time from the backend invoke call to the end of its stream, in seconds. */
  readonly backendInvokeSeconds?: number;
  /** Bytes streamed back to the caller. */
  readonly streamedBytes?: number;
  /** Model input tokens the agent reported in its usage event. */
  readonly modelInputTokens?: number;
  /** Model output tokens the agent reported in its usage event. */
  readonly modelOutputTokens?: number;
}

/** Builds the EMF record (exported so tests can assert its shape). */
export function emfRecord(m: RequestMetrics, timestamp: number = Date.now()): Record<string, unknown> {
  const metrics: { Name: string; Unit: string }[] = [
    { Name: METRIC_NAMES.Requests, Unit: 'Count' },
    { Name: METRIC_NAMES.Errors4xx, Unit: 'Count' },
    { Name: METRIC_NAMES.Errors5xx, Unit: 'Count' },
  ];
  const values: Record<string, number> = {
    Requests: 1,
    Errors4xx: m.status >= 400 && m.status < 500 ? 1 : 0,
    Errors5xx: m.status >= 500 ? 1 : 0,
  };
  const optional: [string, string, number | undefined][] = [
    [METRIC_NAMES.IngressDurationMs, 'Milliseconds', m.ingressDurationMs],
    [METRIC_NAMES.TtfbMs, 'Milliseconds', m.ttfbMs],
    [METRIC_NAMES.BackendInvokeSeconds, 'Seconds', m.backendInvokeSeconds],
    [METRIC_NAMES.StreamedBytes, 'Bytes', m.streamedBytes],
    [METRIC_NAMES.ModelInputTokens, 'Count', m.modelInputTokens],
    [METRIC_NAMES.ModelOutputTokens, 'Count', m.modelOutputTokens],
  ];
  for (const [name, unit, value] of optional) {
    if (value !== undefined) {
      metrics.push({ Name: name, Unit: unit });
      values[name] = value;
    }
  }
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: METRICS_NAMESPACE,
          Dimensions: [['TenantId', 'Ingress']],
          Metrics: metrics,
        },
      ],
    },
    TenantId: m.tenantId,
    Ingress: m.ingress,
    Status: m.status,
    ...values,
  };
}

/** Emits one EMF record for a request. */
export function emitRequestMetrics(m: RequestMetrics, out: (line: string) => void = defaultOut): void {
  out(JSON.stringify(emfRecord(m)) + '\n');
}

function defaultOut(line: string): void {
  process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// The usage event (ADR-0017): the agent's last SSE event.
//
//   event: usage
//   data: {"inputTokens":123,"outputTokens":45,"modelId":"amazon.nova-lite-v1:0"}
//
// `modelId` is absent when no model was called (the probe commands report
// zeros). The ingress forwards the stream unchanged; the client sees the
// event too.
// ---------------------------------------------------------------------------

/** The SSE event name that carries usage. */
export const USAGE_EVENT = 'usage';

export interface UsageEvent {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId?: string;
}

/** Bytes of stream tail the scanner keeps; the usage event is the last event and well under this. */
export const USAGE_TAIL_BYTES = 4096;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * A Bedrock model id, inference-profile id or ARN: letters, digits and
 * `. : / _ -`, bounded. The ingress logs this field, so a value that could
 * carry free text (content) is dropped rather than written.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9.:/_-]{1,256}$/;

function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/**
 * Finds the FINAL `event: usage` SSE event in `sseText` and returns its
 * figures, or undefined when there is none or its data is not well formed.
 * Only the numbers and the model id are read; the rest of the stream is not
 * interpreted.
 */
export function parseUsageEvent(sseText: string): UsageEvent | undefined {
  // SSE events are separated by a blank line; CRLF is normalised first.
  const blocks = sseText.replace(/\r\n/g, '\n').split('\n\n');
  for (let i = blocks.length - 1; i >= 0; i--) {
    const lines = blocks[i].split('\n');
    const isUsage = lines.some((l) => /^event:\s*usage\s*$/.test(l));
    if (!isUsage) {
      continue;
    }
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).replace(/^ /, ''))
      .join('\n');
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (!nonNegativeInteger(parsed.inputTokens) || !nonNegativeInteger(parsed.outputTokens)) {
        return undefined;
      }
      return {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        ...(isModelId(parsed.modelId) ? { modelId: parsed.modelId } : {}),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Feeds stream chunks and keeps a bounded tail (the last USAGE_TAIL_BYTES of
 * text), so the usage event is found whatever the chunk boundaries and the
 * memory held is constant however long the stream. Multi-byte characters
 * split across chunks are handled by the streaming decoder.
 */
export class UsageEventScanner {
  private tail = '';
  private readonly decoder = new TextDecoder('utf-8');

  constructor(private readonly tailChars: number = USAGE_TAIL_BYTES) {}

  feed(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.tail = (this.tail + text).slice(-this.tailChars);
  }

  /** The usage event seen so far, or undefined. Call once the stream has ended. */
  result(): UsageEvent | undefined {
    const rest = this.decoder.decode();
    if (rest.length > 0) {
      this.tail = (this.tail + rest).slice(-this.tailChars);
    }
    return parseUsageEvent(this.tail);
  }
}
