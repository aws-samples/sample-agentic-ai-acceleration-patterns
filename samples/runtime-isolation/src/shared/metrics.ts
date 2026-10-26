// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant metrics as CloudWatch embedded metric format (P-9, standard
 * §4.4): one EMF record per request with the verified tenant as a dimension.
 * Written straight to stdout, not through console.log, because the Lambda
 * JSON log format wraps console output and CloudWatch then no longer
 * recognises the record as EMF.
 */

/** The ingress that served the request; the second EMF dimension. */
export type IngressKind = 'api-gateway' | 'agentcore-gateway';

export const METRICS_NAMESPACE = 'RuntimeIsolation';

export interface RequestMetrics {
  /** The verified `tenant_id`; a dimension, never free text. */
  readonly tenantId: string;
  readonly ingress: IngressKind;
  /** HTTP status the ingress returned. */
  readonly status: number;
  /** Time to first byte from the backend, in milliseconds, when a call was made. */
  readonly ttfbMs?: number;
  /** Bytes streamed back to the caller. */
  readonly streamedBytes?: number;
}

/** Builds the EMF record (exported so tests can assert its shape). */
export function emfRecord(m: RequestMetrics, timestamp: number = Date.now()): Record<string, unknown> {
  const metrics: { Name: string; Unit: string }[] = [
    { Name: 'Requests', Unit: 'Count' },
    { Name: 'Errors4xx', Unit: 'Count' },
    { Name: 'Errors5xx', Unit: 'Count' },
  ];
  const values: Record<string, number> = {
    Requests: 1,
    Errors4xx: m.status >= 400 && m.status < 500 ? 1 : 0,
    Errors5xx: m.status >= 500 ? 1 : 0,
  };
  if (m.ttfbMs !== undefined) {
    metrics.push({ Name: 'TtfbMs', Unit: 'Milliseconds' });
    values.TtfbMs = m.ttfbMs;
  }
  if (m.streamedBytes !== undefined) {
    metrics.push({ Name: 'StreamedBytes', Unit: 'Bytes' });
    values.StreamedBytes = m.streamedBytes;
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
