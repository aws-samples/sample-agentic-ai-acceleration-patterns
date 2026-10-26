// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { BackendResponse, InvokeBackend, ValidatedRequest } from '../../src/backend/backend';
import { ENV } from '../../src/shared/config';
import { IngressPipeline, pipelineFor } from '../../src/shared/request';
import { TokenVerifier } from '../../src/shared/verifier';
import { baseConfig, CLIENT_ID, DISCOVERY_URL, testIssuer, type TestIssuer } from '../helpers';

// The handler reads its configuration at cold start only when invoked; the
// module itself must load without the Lambda streaming global.
process.env[ENV.INGRESS] = 'api-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
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

const event = (authorization: string | undefined, body: string | null, extra: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent =>
  ({
    headers: authorization === undefined ? {} : { Authorization: authorization },
    body,
    isBase64Encoded: false,
    requestContext: { authorizer: { tenantId: 'tenant-a', sub: 'user-a1' } } as any,
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
    });
  });
  beforeEach(() => {
    metrics = [];
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((l: string) => {
      logs.push(l);
    });
  });
  afterEach(() => logSpy.mockRestore());

  const ticking = () => {
    let t = 1000;
    return () => (t += 100);
  };
  const deps = (backend: InvokeBackend) => ({ pipeline, backend, metricsOut: (l: string) => metrics.push(l), now: ticking() });

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
  });

  it('writes the verified tenantId and the session prefix as log fields, never the token (P-9)', async () => {
    const token = await issuer.mint();
    const backend = new FakeBackend();
    await handleRequest(event(`Bearer ${token}`, '{"prompt":"hi","conversationId":"conversationA1x0001"}'), writer().out, deps(backend));
    const served = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request served');
    expect(served.tenantId).toBe('tenant-a');
    expect(served.sessionPrefix).toBe(backend.requests[0].unitId.split('-')[1]);
    expect(served.ingress).toBe('api-gateway');
    expect(served.status).toBe(200);
    expect(served.ttfbMs).toBe(100);
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
    expect(record.Requests).toBe(1);
    expect(record.TtfbMs).toBe(100);
    expect(record.StreamedBytes).toBe(18);
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
    // A refusal is still attributed to the tenant the authoriser verified.
    expect(JSON.parse(metrics[0]).TenantId).toBe('tenant-a');
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
});
