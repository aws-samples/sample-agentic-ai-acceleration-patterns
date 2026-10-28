// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { BackendResponse, InvokeBackend, ValidatedRequest } from '../../src/backend/backend';
import { ENV } from '../../src/shared/config';
import type { Admission, TenantLimiter } from '../../src/shared/limits';
import { IngressPipeline, pipelineFor } from '../../src/shared/request';
import { TokenVerifier } from '../../src/shared/verifier';
import { baseConfig, CLIENT_ID, DISCOVERY_URL, REGISTRY_PREFIX, RUNTIME_ARN, stubRegistry, testIssuer, type TestIssuer } from '../helpers';

// The handler reads its configuration at cold start only when invoked; the
// module itself must load without the Lambda streaming global.
process.env[ENV.INGRESS] = 'api-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
process.env[ENV.REGISTRY_PREFIX] = REGISTRY_PREFIX;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleRequest, handler } = require('../../src/ingress/api-gateway-ingress.function') as typeof import('../../src/ingress/api-gateway-ingress.function');

/** The streaming Lambda (spec C-3a): the pipeline's verdict on the wire, the backend stream relayed, P-9 telemetry. */
class FakeBackend implements InvokeBackend {
  requests: ValidatedRequest[] = [];
  constructor(private readonly chunks: string[] = ['data: a\n\n', 'data: b\n\n'], private readonly fail?: Error) {}
  async invoke(request: ValidatedRequest): Promise<BackendResponse> {
    this.requests.push(request);
    if (this.fail) {
      throw this.fail;
    }
    const chunks = this.chunks;
    return {
      contentType: 'text/event-stream',
      body: (async function* () {
        for (const c of chunks) {
          yield Buffer.from(c);
        }
      })(),
    };
  }
}

interface Written {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  ended: boolean;
}

const writer = () => {
  const w: Written = { body: '', ended: false };
  return {
    w,
    out: {
      start: (status: number, headers: Record<string, string>) => {
        w.status = status;
        w.headers = headers;
      },
      write: (chunk: Uint8Array | string) => {
        w.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      },
      end: () => {
        w.ended = true;
      },
    },
  };
};

/** The registry the tests resolve through: `agent` (no scopes), `billing` (needs write), `old` (draining). */
const ENTRIES = {
  billing: { runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-1', requiredScopes: ['tenant-api/write'], status: 'active' as const },
  old: { runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_old-1', requiredScopes: [], status: 'draining' as const },
};

/** A proxy event as API Gateway sends it for `POST /{backend}/invocations`: `path` is the called path, stage stripped. */
const event = (authorization: string | undefined, body: string | null, extra: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent =>
  ({
    headers: authorization === undefined ? {} : { Authorization: authorization },
    body,
    isBase64Encoded: false,
    path: '/agent/invocations',
    pathParameters: { backend: 'agent' },
    requestContext: { authorizer: { tenantId: 'tenant-a', sub: 'user-a1', backend: 'agent', runtimeArn: RUNTIME_ARN }, path: '/prod/agent/invocations', resourcePath: '/{backend}/invocations' } as any,
    ...extra,
  }) as APIGatewayProxyEvent;

describe('handleRequest', () => {
  let issuer: TestIssuer;
  let pipeline: IngressPipeline;
  let metrics: string[];
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeAll(async () => {
    issuer = await testIssuer();
    pipeline = pipelineFor(baseConfig({ sessionScope: 'user' }), {
      verifier: new TokenVerifier(
        { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
        { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
      ),
      registry: stubRegistry(ENTRIES).registry,
    });
  });
  beforeEach(() => {
    metrics = [];
    logs = [];
    logSpy = jest.spyOn(process.stdout, 'write').mockImplementation((l: any) => {
      logs.push(String(l).trimEnd());
      return true;
    });
  });
  afterEach(() => logSpy.mockRestore());

  const ticking = () => {
    let t = 1000;
    return () => (t += 100);
  };
  const deps = (backend: InvokeBackend, p: IngressPipeline = pipeline) => ({
    pipeline: p,
    backend,
    metricsOut: (l: string) => metrics.push(l),
    now: ticking(),
    perTenantMetrics: true,
  });

  it('awaits deps.ready before any work, so init-time pre-connects are reused (ADR-0023)', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = new FakeBackend();
    const { w, out } = writer();
    const run = handleRequest(event(`Bearer ${await issuer.mint()}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), out, { ...deps(backend), ready });
    await new Promise((resolve) => setImmediate(resolve));
    expect(backend.requests).toHaveLength(0);
    expect(w.status).toBeUndefined();
    release();
    await run;
    expect(backend.requests).toHaveLength(1);
    expect(w.status).toBe(200);
  });

  it('relays the backend stream with its content type and 200', async () => {
    const backend = new FakeBackend();
    const { w, out } = writer();
    await handleRequest(event(`Bearer ${await issuer.mint()}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), out, deps(backend));
    expect(w.status).toBe(200);
    expect(w.headers).toEqual({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    expect(w.body).toBe('data: a\n\ndata: b\n\n');
    expect(w.ended).toBe(true);
    expect(backend.requests[0].prompt).toBe('hi');
    expect(backend.requests[0].unitId).toMatch(/^s-[a-z2-7]{26}-conversationA1x0001$/);
    // The route's backend and its Runtime ARN reach the invoke (ADR-0024).
    expect(backend.requests[0]).toMatchObject({ backend: 'agent', runtimeArn: RUNTIME_ARN });
  });

  describe('backend routing (ADR-0024)', () => {
    const body = '{"prompt":"hi","conversationId":"conversationA1x0001"}';
    const route = (path: string, backend?: string) =>
      ({ path, pathParameters: backend === undefined ? null : { backend }, requestContext: { authorizer: { tenantId: 'tenant-a', sub: 'user-a1', backend } } }) as unknown as Partial<APIGatewayProxyEvent>;

    it('the path names the backend; its registry entry supplies the Runtime ARN the invoke uses', async () => {
      const backend = new FakeBackend();
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body, route('/billing/invocations', 'billing')), writer().out, deps(backend));
      expect(backend.requests[0]).toMatchObject({ backend: 'billing', runtimeArn: ENTRIES.billing.runtimeArn });
      const served = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served');
      expect(served.backend).toBe('billing');
      const record = JSON.parse(metrics[0]);
      expect(record.Backend).toBe('billing');
      expect(record._aws.CloudWatchMetrics[0].Dimensions).toEqual([
        ['TenantId', 'Ingress'],
        ['TenantId', 'Ingress', 'Backend'],
      ]);
    });

    it.each([
      ['unknown backend', '/nope/invocations', 'nope', 'unknown_backend'],
      ['draining backend', '/old/invocations', 'old', 'backend_draining'],
    ])('%s -> 404 "not found", no backend call, reason logged', async (_n, path, name, reason) => {
      const backend = new FakeBackend();
      const { w, out } = writer();
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body, route(path, name)), out, deps(backend));
      expect(w.status).toBe(404);
      expect(w.body).toBe('not found');
      expect(w.ended).toBe(true);
      expect(backend.requests).toHaveLength(0);
      const refused = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request refused');
      expect(refused).toMatchObject({ status: 404, reason, tenantId: 'tenant-a', backend: name });
      expect(JSON.parse(metrics[0])).toMatchObject({ Errors4xx: 1, TenantId: 'tenant-a', Backend: name });
    });

    it("a token without the backend's scopes -> 403 \"forbidden\" backend_scope_missing", async () => {
      const backend = new FakeBackend();
      const { w, out } = writer();
      await handleRequest(event(`Bearer ${await issuer.mint({ scope: 'tenant-api/read' })}`, body, route('/billing/invocations', 'billing')), out, deps(backend));
      expect(w.status).toBe(403);
      expect(w.body).toBe('forbidden');
      expect(backend.requests).toHaveLength(0);
      expect(logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request refused')).toMatchObject({ status: 403, reason: 'backend_scope_missing', backend: 'billing' });
    });

    it('the bare /invocations route serves the default backend', async () => {
      const backend = new FakeBackend();
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body, route('/invocations')), writer().out, deps(backend));
      expect(backend.requests[0]).toMatchObject({ backend: 'agent', runtimeArn: RUNTIME_ARN });
    });
  });

  it('writes the verified tenantId and the session prefix as log fields, never the token (P-9)', async () => {
    const token = await issuer.mint();
    const backend = new FakeBackend();
    await handleRequest(event(`Bearer ${token}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), writer().out, deps(backend));
    const served = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served');
    expect(served.tenantId).toBe('tenant-a');
    expect(served.backend).toBe('agent');
    expect(served.sessionPrefix).toBe(backend.requests[0].unitId.split('-')[1]);
    expect(served.ingress).toBe('api-gateway');
    expect(served.status).toBe(200);
    // The clock ticks 100 ms per read: start, invoke start, first chunk.
    expect(served.ttfbMs).toBe(200);
    expect(served.streamedBytes).toBe(18);
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).not.toContain('conversationA1x0001');
  });

  it('emits one EMF record per request with TenantId, TTFB and streamed bytes', async () => {
    await handleRequest(event(`Bearer ${await issuer.mint()}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), writer().out, deps(new FakeBackend()));
    expect(metrics).toHaveLength(1);
    const record = JSON.parse(metrics[0]);
    expect(record.TenantId).toBe('tenant-a');
    expect(record.Ingress).toBe('api-gateway');
    expect(record.Backend).toBe('agent');
    expect(record.Requests).toBe(1);
    expect(record.TtfbMs).toBe(200);
    expect(record.StreamedBytes).toBe(18);
  });

  describe('cost metering (P-10, ADR-0017)', () => {
    const USAGE = 'event: usage\ndata: {"inputTokens":17,"outputTokens":42,"modelId":"amazon.nova-lite-v1:0"}\n\n';
    const body = '{"prompt":"what is runtime isolation?","conversationId":"conversationA1x0001"}';

    it('reads the usage event off the stream and emits tokens, backend seconds, ingress ms and bytes once per request', async () => {
      // now() ticks 100 ms per read, so every duration is a positive, ordered number.
      const chunks = ['data: {"text":"Hel"}\n\n', 'data: {"text":"lo"}\n\n', USAGE];
      const { w, out } = writer();
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), out, deps(new FakeBackend(chunks)));
      expect(metrics).toHaveLength(1);
      const record = JSON.parse(metrics[0]);
      expect(record).toMatchObject({
        TenantId: 'tenant-a',
        Ingress: 'api-gateway',
        Requests: 1,
        ModelInputTokens: 17,
        ModelOutputTokens: 42,
        StreamedBytes: Buffer.byteLength(chunks.join('')),
      });
      expect(record.BackendInvokeSeconds).toBeGreaterThan(0);
      expect(record.IngressDurationMs).toBeGreaterThan(record.BackendInvokeSeconds * 1000);
      expect(record.TtfbMs).toBeGreaterThan(0);
      const names = record._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name);
      expect(names).toEqual(expect.arrayContaining(['Requests', 'IngressDurationMs', 'BackendInvokeSeconds', 'ModelInputTokens', 'ModelOutputTokens', 'StreamedBytes']));
      // The stream reached the caller byte for byte, usage event included.
      expect(w.body).toBe(chunks.join(''));
      // The log carries figures, never the streamed text.
      const served = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served');
      expect(served).toMatchObject({ usageInput: 17, usageOutput: 42, modelId: 'amazon.nova-lite-v1:0', usageReported: true });
      expect(logs.join('\n')).not.toContain('Hel');
      expect(metrics[0]).not.toContain('Hel');
      // Nor the prompt.
      expect(logs.join('\n')).not.toContain('what is runtime isolation');
      expect(metrics[0]).not.toContain('what is runtime isolation');
    });

    it('finds the usage event when it is split across chunks', async () => {
      const chunks = ['data: {"text":"x"}\n\neven', 't: usage\ndata: {"inputTokens":1,"out', 'putTokens":2,"modelId":"m"}\n\n'];
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, deps(new FakeBackend(chunks)));
      expect(JSON.parse(metrics[0])).toMatchObject({ ModelInputTokens: 1, ModelOutputTokens: 2 });
    });

    it('a stream without a usage event leaves the token metrics absent (a visible gap, not a guess)', async () => {
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, deps(new FakeBackend()));
      const record = JSON.parse(metrics[0]);
      expect(record).not.toHaveProperty('ModelInputTokens');
      expect(record).not.toHaveProperty('ModelOutputTokens');
      expect(record.BackendInvokeSeconds).toBeGreaterThan(0);
      expect(record.IngressDurationMs).toBeGreaterThan(0);
      expect(logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served').usageReported).toBe(false);
    });

    it('a refusal carries IngressDurationMs but no backend or model figures', async () => {
      await handleRequest(event(undefined, body), writer().out, deps(new FakeBackend()));
      const record = JSON.parse(metrics[0]);
      expect(record.Errors4xx).toBe(1);
      expect(record.IngressDurationMs).toBeGreaterThan(0);
      for (const absent of ['BackendInvokeSeconds', 'ModelInputTokens', 'ModelOutputTokens', 'StreamedBytes', 'TtfbMs']) {
        expect(record).not.toHaveProperty(absent);
      }
    });

    it('a backend failure (502) carries IngressDurationMs and no BackendInvokeSeconds', async () => {
      const error = new Error('x');
      error.name = 'AccessDeniedException';
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, deps(new FakeBackend([], error)));
      const record = JSON.parse(metrics[0]);
      expect(record.Errors5xx).toBe(1);
      expect(record.IngressDurationMs).toBeGreaterThan(0);
      expect(record).not.toHaveProperty('BackendInvokeSeconds');
    });
  });

  it.each([
    ['no token', undefined, '{"prompt":"hi","conversationId":"conversationA1x0001"}', 401, 'unauthorized'],
    ['bad body', 'VALID', 'nope', 400, 'bad request'],
    ['missing conversationId', 'VALID', '{"prompt":"hi"}', 400, 'bad request'],
  ])('%s -> fixed text and no backend call', async (_name, auth, body, status, text) => {
    const backend = new FakeBackend();
    const { w, out } = writer();
    const authorization = auth === 'VALID' ? `Bearer ${await issuer.mint()}` : auth;
    await handleRequest(event(authorization, body), out, deps(backend));
    expect(w.status).toBe(status);
    expect(w.body).toBe(text);
    expect(w.ended).toBe(true);
    expect(backend.requests).toHaveLength(0);
    expect(JSON.parse(metrics[0])[status < 500 ? 'Errors4xx' : 'Errors5xx']).toBe(1);
    // A refusal is still attributed to the tenant and backend the authoriser resolved.
    expect(JSON.parse(metrics[0])).toMatchObject({ TenantId: 'tenant-a', Backend: 'agent' });
  });

  it('403 for a token without tenant_id', async () => {
    const { w, out } = writer();
    await handleRequest(event(`Bearer ${await issuer.mint({ tenant_id: undefined })}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), out, deps(new FakeBackend()));
    expect(w.status).toBe(403);
    expect(w.body).toBe('forbidden');
  });

  it('502 with fixed text when the backend fails, with the error name only in the log', async () => {
    const { w, out } = writer();
    const error = new Error('contains session id s-secret');
    error.name = 'AccessDeniedException';
    await handleRequest(event(`Bearer ${await issuer.mint()}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), out, deps(new FakeBackend([], error)));
    expect(w.status).toBe(502);
    expect(w.body).toBe('upstream error');
    expect(logs.join('\n')).toContain('AccessDeniedException');
    expect(logs.join('\n')).not.toContain('s-secret');
    expect(JSON.parse(metrics[0]).Errors5xx).toBe(1);
  });

  it('decodes a base64 body', async () => {
    const backend = new FakeBackend();
    const body = Buffer.from('{"prompt":"hi","conversationId":"conversationA1x0001"}').toString('base64');
    await handleRequest(event(`Bearer ${await issuer.mint()}`, body, { isBase64Encoded: true }), writer().out, deps(backend));
    expect(backend.requests[0].prompt).toBe('hi');
  });

  it('finds the Authorization header case-insensitively', async () => {
    const backend = new FakeBackend();
    const e = event(undefined, '{"prompt":"hi","conversationId":"conversationA1x0001"}');
    e.headers = { authorization: `Bearer ${await issuer.mint()}` };
    await handleRequest(e, writer().out, deps(backend));
    expect(backend.requests).toHaveLength(1);
  });

  it('exports a handler even without the Lambda streaming global', () => {
    expect(typeof handler).toBe('function');
  });
  describe('per-tenant limits and metrics opt-in (ADR-0020, ADR-0021)', () => {
    const body = '{"prompt":"hi","conversationId":"conversationA1x0001"}';
    const USAGE = 'event: usage\ndata: {"inputTokens":17,"outputTokens":42,"modelId":"m"}\n\n';
    const limited = (verdict: Admission) => {
      const recorded: Array<[string, number]> = [];
      const limiter = {
        admit: async () => verdict,
        recordOutputTokens: async (tenantId: string, n: number) => {
          recorded.push([tenantId, n]);
        },
      } as unknown as TenantLimiter;
      const p = pipelineFor(baseConfig({ sessionScope: 'user', limits: { tableName: 'TenantLimits', requestsPerMinute: 1, outputTokensPerMinute: 100 } }), {
        verifier: new TokenVerifier(
          { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
          { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
        ),
        limiter,
        registry: stubRegistry().registry,
      });
      return { p, recorded };
    };

    it('a limited tenant gets 429 "too many requests" and no backend call', async () => {
      const { p } = limited('limited');
      const backend = new FakeBackend();
      const { w, out } = writer();
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), out, deps(backend, p));
      expect(w.status).toBe(429);
      expect(w.body).toBe('too many requests');
      expect(backend.requests).toHaveLength(0);
      const refused = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request refused');
      expect(refused).toMatchObject({ status: 429, reason: 'tenant_rate_limited', tenantId: 'tenant-a' });
      expect(JSON.parse(metrics[0])).toMatchObject({ TenantId: 'tenant-a', Errors4xx: 1 });
    });

    it("records the usage event's outputTokens against the tenant after the stream", async () => {
      const { p, recorded } = limited('admitted');
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, deps(new FakeBackend(['data: x\n\n', USAGE]), p));
      expect(recorded).toEqual([['tenant-a', 42]]);
    });

    it('records nothing when the stream carries no usage event', async () => {
      const { p, recorded } = limited('admitted');
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, deps(new FakeBackend(), p));
      expect(recorded).toEqual([]);
    });

    it('per-tenant metrics are off by default: nothing on metricsOut, the log line still carries the figures', async () => {
      const { perTenantMetrics: _on, ...off } = deps(new FakeBackend(['data: x\n\n', USAGE]));
      await handleRequest(event(`Bearer ${await issuer.mint()}`, body), writer().out, off);
      await handleRequest(event(undefined, body), writer().out, off);
      expect(metrics).toEqual([]);
      const served = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served');
      expect(served).toMatchObject({ tenantId: 'tenant-a', usageOutput: 42 });
      expect(logs.some((l) => l.includes('_aws'))).toBe(false);
    });
  });
});
