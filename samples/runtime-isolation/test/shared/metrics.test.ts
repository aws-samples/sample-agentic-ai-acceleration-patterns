// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { emfRecord, emitRequestMetrics, METRICS_NAMESPACE } from '../../src/shared/metrics';

/** P-9: per-tenant EMF with requests, 4xx/5xx, TTFB and streamed bytes. */
describe('emfRecord', () => {
  it('carries TenantId and Ingress as the dimension set and counts a 2xx as a request', () => {
    const record = emfRecord({ tenantId: 'tenant-a', ingress: 'api-gateway', status: 200, ttfbMs: 250, streamedBytes: 1024 }, 1700000000000) as any;
    expect(record._aws.Timestamp).toBe(1700000000000);
    expect(record._aws.CloudWatchMetrics[0].Namespace).toBe(METRICS_NAMESPACE);
    expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([['TenantId', 'Ingress']]);
    expect(record.TenantId).toBe('tenant-a');
    expect(record.Ingress).toBe('api-gateway');
    expect(record.Requests).toBe(1);
    expect(record.Errors4xx).toBe(0);
    expect(record.Errors5xx).toBe(0);
    expect(record.TtfbMs).toBe(250);
    expect(record.StreamedBytes).toBe(1024);
    expect(record._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name)).toEqual([
      'Requests',
      'Errors4xx',
      'Errors5xx',
      'TtfbMs',
      'StreamedBytes',
    ]);
  });

  it('counts 4xx and 5xx separately and omits TTFB/bytes when there was no stream', () => {
    const r4 = emfRecord({ tenantId: 't', ingress: 'agentcore-gateway', status: 403 }) as any;
    expect(r4.Errors4xx).toBe(1);
    expect(r4.Errors5xx).toBe(0);
    expect(r4).not.toHaveProperty('TtfbMs');
    expect(r4._aws.CloudWatchMetrics[0].Metrics).toHaveLength(3);
    const r5 = emfRecord({ tenantId: 't', ingress: 'agentcore-gateway', status: 502 }) as any;
    expect(r5.Errors5xx).toBe(1);
  });

  it('emitRequestMetrics writes one newline-terminated JSON line to the sink', () => {
    const lines: string[] = [];
    emitRequestMetrics({ tenantId: 't', ingress: 'api-gateway', status: 200 }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]).TenantId).toBe('t');
  });
});
