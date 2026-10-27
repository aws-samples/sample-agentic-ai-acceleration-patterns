// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AgentCoreRuntimeBackend, RUNTIME_HEADERS } from '../../src/backend/agentcore-runtime.transport';
import { ENV } from '../../src/shared/config';
import type { TenantLimiter } from '../../src/shared/limits';
import { pipelineFor } from '../../src/shared/request';
import { sessionPrefix } from '../../src/shared/session';
import { TokenVerifier } from '../../src/shared/verifier';
import { baseConfig, CLIENT_ID, DISCOVERY_URL, testIssuer, type TestIssuer } from '../helpers';

process.env[ENV.INGRESS] = 'agentcore-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bodyText, intercept, handler } = require('../../src/ingress/gateway-interceptor.function') as typeof import('../../src/ingress/gateway-interceptor.function');

/** The REQUEST interceptor (spec C-3b, ADR-0002 as decided): builds the unit id, overwrites the header, denies with fixed text. */
describe('intercept', () => {
  let issuer: TestIssuer;
  let metrics: string[];
  let logs: string[];
  let logSpy: jest.SpyInstance;
  const backend = new AgentCoreRuntimeBackend('');

  beforeAll(async () => {
    issuer = await testIssuer();
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

  const deps = (config = baseConfig({ ingress: 'agentcore-gateway', sessionScope: 'user' })) => ({
    pipeline: pipelineFor(config, {
      verifier: new TokenVerifier(
        {
          discoveryUrl: DISCOVERY_URL,
          allowedClientIds: [CLIENT_ID],
          requiredScopes: config.requiredScopes,
          requireNarrowedToken: config.delegation.requireNarrowedToken,
          allowedScopes: config.delegation.allowedScopes,
        },
        { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
      ),
    }),
    backend,
    metricsOut: (l: string) => metrics.push(l),
    perTenantMetrics: true,
  });

  const event = (headers: Record<string, string>, body: unknown) => ({
    interceptorInputVersion: '1.0',
    http: { gatewayRequest: { path: '/agent/invocations', headers, body } },
  });

  const body = '{"prompt":"hi","conversationId":"conversationA1x0001"}';

  it('builds the unit id from the verified claims and OVERWRITES the client session header (spike V-3)', async () => {
    const token = await issuer.mint();
    const out = await intercept(
      event({ Authorization: `Bearer ${token}`, [RUNTIME_HEADERS.SESSION_ID]: 's-bbbbbbbbbbbbbbbbbbbbbbbbbb-conversationB1x0001' }, body),
      deps(),
    );
    expect(out.interceptorOutputVersion).toBe('1.0');
    const http = out.http as { transformedGatewayRequest: { headers: Record<string, string>; body: unknown } };
    expect(http.transformedGatewayRequest.headers).toEqual({
      [RUNTIME_HEADERS.SESSION_ID]: `s-${sessionPrefix('tenant-a', 'user-a1', 'user')}-conversationA1x0001`,
    });
    expect(http.transformedGatewayRequest.body).toBe(body);
  });

  it('awaits deps.ready before any work (ADR-0023)', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const run = intercept(event({ Authorization: `Bearer ${await issuer.mint()}` }, body), { ...deps(), ready }).then((out) => {
      settled = true;
      return out;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    const out = await run;
    expect(settled).toBe(true);
    expect('transformedGatewayRequest' in out.http).toBe(true);
  });

  it('a request with no session header gets one too: the client never needs to send it (ADR-0002)', async () => {
    const out = await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, body), deps());
    const http = out.http as { transformedGatewayRequest: { headers: Record<string, string> } };
    expect(http.transformedGatewayRequest.headers[RUNTIME_HEADERS.SESSION_ID]).toMatch(/^s-[a-z2-7]{26}-conversationA1x0001$/);
  });

  it('session off: a random unit id per request and conversationId refused (ADR-0013)', async () => {
    const d = deps(baseConfig({ ingress: 'agentcore-gateway' }));
    const a = await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, '{"prompt":"hi"}'), d);
    const b = await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, '{"prompt":"hi"}'), d);
    const ida = (a.http as any).transformedGatewayRequest.headers[RUNTIME_HEADERS.SESSION_ID];
    const idb = (b.http as any).transformedGatewayRequest.headers[RUNTIME_HEADERS.SESSION_ID];
    expect(ida).toMatch(/^s-[a-z2-7]{52}$/);
    expect(ida).not.toBe(idb);
    const refused = await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, body), d);
    expect((refused.http as any).transformedGatewayResponse.statusCode).toBe(400);
  });

  it('forwards the user token and the vended credentials in the Runtime custom headers when on (P-5, P-8)', async () => {
    const token = await issuer.mint();
    const d = deps(baseConfig({ ingress: 'agentcore-gateway', sessionScope: 'user', delegation: { forwardUserToken: true, requireNarrowedToken: false } }));
    const out = await intercept(event({ authorization: `Bearer ${token}` }, body), d);
    const headers = (out.http as any).transformedGatewayRequest.headers;
    expect(headers[RUNTIME_HEADERS.USER_TOKEN]).toBe(token);
    expect(headers[RUNTIME_HEADERS.TENANT_CREDENTIALS]).toBeUndefined();
  });

  it.each<[string, boolean, number, string]>([
    ['no Authorization', false, 401, 'unauthorized'],
    ['bad prompt', true, 400, 'bad request'],
  ])('%s (token: %s) -> fixed-text response %i', async (_n, withToken, status, text) => {
    const h: Record<string, string> = withToken ? { authorization: `Bearer ${await issuer.mint()}` } : {};
    const b = withToken ? '{"prompt":42,"conversationId":"conversationA1x0001"}' : body;
    const out = await intercept(event(h, b), deps());
    const response = (out.http as any).transformedGatewayResponse;
    expect(response.statusCode).toBe(status);
    expect(response.contentType).toBe('text/plain');
    expect(Buffer.from(response.body, 'base64').toString()).toBe(text);
    expect(JSON.parse(metrics[0]).Errors4xx).toBe(1);
  });

  it('403 for a token without tenant_id, and for a missing required scope', async () => {
    const a = await intercept(event({ authorization: `Bearer ${await issuer.mint({ tenant_id: undefined })}` }, body), deps());
    expect((a.http as any).transformedGatewayResponse.statusCode).toBe(403);
    const d = deps(baseConfig({ ingress: 'agentcore-gateway', sessionScope: 'user', requiredScopes: ['tenant-api/read'] }));
    const b = await intercept(event({ authorization: `Bearer ${await issuer.mint({ scope: 'tenant-api/write' })}` }, body), d);
    expect((b.http as any).transformedGatewayResponse.statusCode).toBe(403);
  });

  it('logs the verified tenantId and session prefix as fields and never a header value (P-9, V-7)', async () => {
    const token = await issuer.mint();
    await intercept(event({ authorization: `Bearer ${token}`, [RUNTIME_HEADERS.SESSION_ID]: 'client-sent-value' }, body), deps());
    const admitted = logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request admitted');
    expect(admitted.tenantId).toBe('tenant-a');
    expect(admitted.sessionPrefix).toBe(sessionPrefix('tenant-a', 'user-a1', 'user'));
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain('client-sent-value');
    expect(all).not.toContain('conversationA1x0001');
    expect(JSON.parse(metrics[0])).toMatchObject({ TenantId: 'tenant-a', Ingress: 'agentcore-gateway', Requests: 1 });
  });

  it('meters the request side only: Requests and IngressDurationMs, no backend or model figures (P-10 gap, ADR-0009 input)', async () => {
    let t = 1000;
    const d = { ...deps(), now: () => (t += 50) };
    await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, body), d);
    expect(metrics).toHaveLength(1);
    const record = JSON.parse(metrics[0]);
    expect(record).toMatchObject({ TenantId: 'tenant-a', Ingress: 'agentcore-gateway', Requests: 1, IngressDurationMs: 50 });
    expect(record._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name)).toEqual(['Requests', 'Errors4xx', 'Errors5xx', 'IngressDurationMs']);
    for (const absent of ['BackendInvokeSeconds', 'ModelInputTokens', 'ModelOutputTokens', 'StreamedBytes', 'TtfbMs']) {
      expect(record).not.toHaveProperty(absent);
    }
    // A refusal is metered the same way.
    await intercept(event({}, body), d);
    expect(JSON.parse(metrics[1])).toMatchObject({ Errors4xx: 1, IngressDurationMs: 50 });
  });

  it('a limited tenant gets a 429 "too many requests" response (ADR-0020)', async () => {
    const config = baseConfig({ ingress: 'agentcore-gateway', sessionScope: 'user', limits: { tableName: 'TenantLimits', requestsPerMinute: 1 } });
    const limiter = { admit: async () => 'limited', recordOutputTokens: async () => undefined } as unknown as TenantLimiter;
    const d = {
      ...deps(config),
      pipeline: pipelineFor(config, {
        verifier: new TokenVerifier(
          { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
          { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
        ),
        limiter,
      }),
    };
    const out = await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, body), d);
    const response = (out.http as any).transformedGatewayResponse;
    expect(response.statusCode).toBe(429);
    expect(Buffer.from(response.body, 'base64').toString()).toBe('too many requests');
    expect(JSON.parse(metrics[0])).toMatchObject({ TenantId: 'tenant-a', Errors4xx: 1 });
  });

  it('per-tenant metrics are off by default (ADR-0021): nothing on metricsOut', async () => {
    const { perTenantMetrics: _on, ...off } = deps();
    await intercept(event({ authorization: `Bearer ${await issuer.mint()}` }, body), off);
    await intercept(event({}, body), off);
    expect(metrics).toEqual([]);
    expect(logs.some((l) => l.includes('_aws'))).toBe(false);
  });

  it('handles a missing http section as a refusal, not a crash', async () => {
    const out = await intercept({}, deps());
    expect((out.http as any).transformedGatewayResponse.statusCode).toBe(401);
  });

  it('exports a handler', () => {
    expect(typeof handler).toBe('function');
  });
});

describe('bodyText', () => {
  it('passes a JSON string through, decodes base64, serialises an object, and treats nothing as null', () => {
    expect(bodyText('{"prompt":"x"}')).toBe('{"prompt":"x"}');
    expect(bodyText(Buffer.from('{"prompt":"x"}').toString('base64'))).toBe('{"prompt":"x"}');
    expect(bodyText({ prompt: 'x' })).toBe('{"prompt":"x"}');
    expect(bodyText(undefined)).toBeNull();
    expect(bodyText(null)).toBeNull();
    expect(bodyText(42)).toBeNull();
  });
});
