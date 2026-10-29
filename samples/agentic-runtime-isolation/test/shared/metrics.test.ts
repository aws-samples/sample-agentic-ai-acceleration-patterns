// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  COST_METRIC_NAMES,
  emfRecord,
  emitRequestMetrics,
  METRIC_NAMES,
  METRICS_NAMESPACE,
  parseUsageEvent,
  USAGE_TAIL_BYTES,
  UsageEventScanner,
} from '../../src/shared/metrics';

/** P-9 and P-10: per-tenant EMF with requests, 4xx/5xx, TTFB, streamed bytes and the cost meters (ADR-0017). */
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

  it('carries the P-10 cost metrics with their units when given (ADR-0017)', () => {
    const record = emfRecord({
      tenantId: 'tenant-a',
      ingress: 'api-gateway',
      status: 200,
      ingressDurationMs: 1234,
      ttfbMs: 250,
      backendInvokeSeconds: 1.1,
      streamedBytes: 1024,
      modelInputTokens: 17,
      modelOutputTokens: 42,
    }) as any;
    const metrics = record._aws.CloudWatchMetrics[0].Metrics as { Name: string; Unit: string }[];
    expect(metrics).toEqual([
      { Name: 'Requests', Unit: 'Count' },
      { Name: 'Errors4xx', Unit: 'Count' },
      { Name: 'Errors5xx', Unit: 'Count' },
      { Name: 'IngressDurationMs', Unit: 'Milliseconds' },
      { Name: 'TtfbMs', Unit: 'Milliseconds' },
      { Name: 'BackendInvokeSeconds', Unit: 'Seconds' },
      { Name: 'StreamedBytes', Unit: 'Bytes' },
      { Name: 'ModelInputTokens', Unit: 'Count' },
      { Name: 'ModelOutputTokens', Unit: 'Count' },
    ]);
    expect(record.IngressDurationMs).toBe(1234);
    expect(record.BackendInvokeSeconds).toBe(1.1);
    expect(record.ModelInputTokens).toBe(17);
    expect(record.ModelOutputTokens).toBe(42);
    // Every metric named in the record has a value, and the six cost metrics are among them.
    for (const m of metrics) {
      expect(typeof record[m.Name]).toBe('number');
    }
    expect(metrics.map((m) => m.Name)).toEqual(expect.arrayContaining([...COST_METRIC_NAMES]));
    expect(Object.values(METRIC_NAMES)).toEqual(metrics.map((m) => m.Name));
  });

  it('counts 4xx and 5xx separately and omits TTFB/bytes/cost meters when there was no stream', () => {
    const r4 = emfRecord({ tenantId: 't', ingress: 'agentcore-gateway', status: 403 }) as any;
    expect(r4.Errors4xx).toBe(1);
    expect(r4.Errors5xx).toBe(0);
    expect(r4).not.toHaveProperty('TtfbMs');
    expect(r4).not.toHaveProperty('BackendInvokeSeconds');
    expect(r4).not.toHaveProperty('ModelInputTokens');
    expect(r4._aws.CloudWatchMetrics[0].Metrics).toHaveLength(3);
    const r5 = emfRecord({ tenantId: 't', ingress: 'agentcore-gateway', status: 502 }) as any;
    expect(r5.Errors5xx).toBe(1);
  });

  it('a request-side-only record (the interceptor) carries IngressDurationMs and nothing from the backend', () => {
    const record = emfRecord({ tenantId: 't', ingress: 'agentcore-gateway', status: 200, ingressDurationMs: 12 }) as any;
    expect(record._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name)).toEqual(['Requests', 'Errors4xx', 'Errors5xx', 'IngressDurationMs']);
    expect(record.IngressDurationMs).toBe(12);
  });

  it('with a backend (ADR-0024) the record adds a [TenantId, Ingress, Backend] dimension set and keeps the two-dimension one first', () => {
    const record = emfRecord({ tenantId: 'tenant-a', ingress: 'api-gateway', status: 200, backend: 'billing' }) as any;
    expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ['TenantId', 'Ingress'],
      ['TenantId', 'Ingress', 'Backend'],
    ]);
    expect(record.Backend).toBe('billing');
    // Without a backend nothing changes: no Backend field, one dimension set.
    const plain = emfRecord({ tenantId: 'tenant-a', ingress: 'api-gateway', status: 200 }) as any;
    expect(plain._aws.CloudWatchMetrics[0].Dimensions).toEqual([['TenantId', 'Ingress']]);
    expect(plain).not.toHaveProperty('Backend');
  });

  it('emitRequestMetrics writes one newline-terminated JSON line to the sink', () => {
    const lines: string[] = [];
    emitRequestMetrics({ tenantId: 't', ingress: 'api-gateway', status: 200 }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]).TenantId).toBe('t');
  });
});

/** The usage event contract (ADR-0017): the agent's last SSE event, read by the ingress. */
const USAGE = 'event: usage\ndata: {"inputTokens":17,"outputTokens":42,"modelId":"amazon.nova-lite-v1:0"}\n\n';
const STREAM = 'data: {"text":"Hel"}\n\ndata: {"text":"lo"}\n\n' + USAGE;

describe('parseUsageEvent', () => {
  it('returns the figures of the final usage event', () => {
    expect(parseUsageEvent(STREAM)).toEqual({ inputTokens: 17, outputTokens: 42, modelId: 'amazon.nova-lite-v1:0' });
  });

  it('takes the LAST usage event when there are several, and ignores data events named usage in their payload', () => {
    const text = 'event: usage\ndata: {"inputTokens":1,"outputTokens":1}\n\ndata: {"event":"usage","inputTokens":9}\n\n' + USAGE;
    expect(parseUsageEvent(text)).toEqual({ inputTokens: 17, outputTokens: 42, modelId: 'amazon.nova-lite-v1:0' });
  });

  it('accepts zeros without a modelId (the probe commands) and CRLF line endings', () => {
    expect(parseUsageEvent('data: {"nonce":"x"}\n\nevent: usage\ndata: {"inputTokens":0,"outputTokens":0}\n\n')).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parseUsageEvent('event: usage\r\ndata: {"inputTokens":3,"outputTokens":4}\r\n\r\n')).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('is undefined when the event is missing, or its data is not well formed', () => {
    expect(parseUsageEvent('')).toBeUndefined();
    expect(parseUsageEvent('data: {"text":"hi"}\n\n')).toBeUndefined();
    expect(parseUsageEvent('{"nonce":"x"}')).toBeUndefined();
    expect(parseUsageEvent('event: usage\ndata: not json\n\n')).toBeUndefined();
    expect(parseUsageEvent('event: usage\ndata: {"inputTokens":"17","outputTokens":42}\n\n')).toBeUndefined();
    expect(parseUsageEvent('event: usage\ndata: {"inputTokens":-1,"outputTokens":42}\n\n')).toBeUndefined();
    expect(parseUsageEvent('event: usage\ndata: {"inputTokens":1.5,"outputTokens":42}\n\n')).toBeUndefined();
    expect(parseUsageEvent('event: usage\ndata: {"outputTokens":42}\n\n')).toBeUndefined();
  });

  it('a modelId that is not a string, or not shaped like a model id, is dropped, not trusted (the ingress logs this field)', () => {
    const usage = (modelId: unknown) => parseUsageEvent(`event: usage\ndata: ${JSON.stringify({ inputTokens: 1, outputTokens: 2, modelId })}\n\n`);
    expect(usage(7)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(usage('')).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(usage('the answer was: 42 <content>')).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(usage('x'.repeat(257))).toEqual({ inputTokens: 1, outputTokens: 2 });
    for (const ok of ['amazon.nova-lite-v1:0', 'eu.amazon.nova-lite-v1:0', 'arn:aws:bedrock:eu-central-1:111122223333:inference-profile/eu.amazon.nova-lite-v1:0']) {
      expect(usage(ok)).toEqual({ inputTokens: 1, outputTokens: 2, modelId: ok });
    }
  });
});

describe('UsageEventScanner', () => {
  const bytes = (s: string) => Buffer.from(s, 'utf8');

  it('finds the usage event when fed the stream in one chunk', () => {
    const scanner = new UsageEventScanner();
    scanner.feed(bytes(STREAM));
    expect(scanner.result()).toEqual({ inputTokens: 17, outputTokens: 42, modelId: 'amazon.nova-lite-v1:0' });
  });

  it('finds it whatever the chunk boundaries, including inside `event: usage`, the data line and a multi-byte character', () => {
    const text = 'data: {"text":"héllo wörld ✓"}\n\n' + USAGE;
    const buf = bytes(text);
    for (const size of [1, 2, 3, 5, 7, 11, 13, 64]) {
      const scanner = new UsageEventScanner();
      for (let i = 0; i < buf.length; i += size) {
        scanner.feed(buf.subarray(i, Math.min(i + size, buf.length)));
      }
      expect(scanner.result()).toEqual({ inputTokens: 17, outputTokens: 42, modelId: 'amazon.nova-lite-v1:0' });
    }
  });

  it('keeps a bounded tail, so a long stream costs constant memory and the final event is still found', () => {
    const scanner = new UsageEventScanner();
    for (let i = 0; i < 10_000; i++) {
      scanner.feed(bytes(`data: {"text":"chunk ${i} ${'x'.repeat(100)}"}\n\n`));
    }
    scanner.feed(bytes(USAGE));
    expect((scanner as any).tail.length).toBeLessThanOrEqual(USAGE_TAIL_BYTES);
    expect(scanner.result()).toEqual({ inputTokens: 17, outputTokens: 42, modelId: 'amazon.nova-lite-v1:0' });
  });

  it('is undefined when the stream carried no usage event, or when the event was followed by more than a tail of data', () => {
    const none = new UsageEventScanner();
    none.feed(bytes('data: {"text":"hi"}\n\n'));
    expect(none.result()).toBeUndefined();
    const buried = new UsageEventScanner(64);
    buried.feed(bytes(USAGE));
    buried.feed(bytes('data: {"text":"' + 'y'.repeat(200) + '"}\n\n'));
    expect(buried.result()).toBeUndefined();
    expect(new UsageEventScanner().result()).toBeUndefined();
  });

  it('accepts string chunks too', () => {
    const scanner = new UsageEventScanner();
    scanner.feed('event: usa');
    scanner.feed('ge\ndata: {"inputTok');
    scanner.feed('ens":1,"outputTokens":2}\n\n');
    expect(scanner.result()).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
