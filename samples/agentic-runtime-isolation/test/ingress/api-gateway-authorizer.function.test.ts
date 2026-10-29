// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { ENV } from '../../src/shared/config';
import { RegistryError } from '../../src/shared/registry';
import type { RegistryResolver } from '../../src/shared/request';
import { TokenVerifier } from '../../src/shared/verifier';
import { CLIENT_ID, DISCOVERY_URL, REGISTRY_PREFIX, RUNTIME_ARN, stubRegistry, testIssuer, type TestIssuer } from '../helpers';

process.env[ENV.INGRESS] = 'api-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
process.env[ENV.REGISTRY_PREFIX] = REGISTRY_PREFIX;
// No default backend: the module-level registry makes no SSM call at load.
delete process.env[ENV.DEFAULT_BACKEND];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const authorizer = require('../../src/ingress/api-gateway-authorizer.function') as typeof import('../../src/ingress/api-gateway-authorizer.function');

/** The Lambda authoriser (spec C-3a, ADR-0024): Allow with {tenantId, sub, backend, runtimeArn} context, explicit Deny otherwise. */
const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123/prod/POST/agent/invocations';
const CONTEXT = { tenantId: 'tenant-a', sub: 'user-a1', backend: 'agent', runtimeArn: RUNTIME_ARN };

const effectOf = (result: { policyDocument: { Statement: unknown[] } }) => (result.policyDocument.Statement[0] as { Effect: string }).Effect;

describe('buildPolicy', () => {
  it('Allow carries the verified tenant and the resolved backend as context for the access log (P-9)', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Allow', CONTEXT);
    expect(result.principalId).toBe('user-a1');
    expect(result.policyDocument.Statement[0]).toEqual({ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN });
    expect(result.context).toEqual(CONTEXT);
  });

  it('Deny carries no context', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Deny');
    expect(result.principalId).toBe('unauthorized');
    expect(effectOf(result)).toBe('Deny');
    expect(result.context).toBeUndefined();
  });
});

describe('authorize', () => {
  let issuer: TestIssuer;
  let verifier: TokenVerifier;
  let logs: string[];
  let spy: jest.SpyInstance;
  const entries = {
    billing: { runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-1', requiredScopes: ['tenant-api/write'], status: 'active' as const },
    old: { runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_old-1', requiredScopes: [], status: 'draining' as const },
  };

  beforeAll(async () => {
    issuer = await testIssuer();
    verifier = new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );
  });
  beforeEach(() => {
    logs = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((l: unknown) => {
      logs.push(String(l).trimEnd());
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  const deps = (registry: RegistryResolver = stubRegistry(entries).registry) => ({ verifier, registry, defaultBackend: 'agent' });
  const event = (headers: Record<string, string>, route: { path?: string; backend?: string } = { path: '/agent/invocations', backend: 'agent' }): APIGatewayRequestAuthorizerEvent =>
    ({
      type: 'REQUEST',
      methodArn: METHOD_ARN,
      headers,
      path: route.path,
      pathParameters: route.backend === undefined ? null : { backend: route.backend },
    }) as unknown as APIGatewayRequestAuthorizerEvent;
  const refusal = () => logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request refused' || l.message === 'token refused');

  it('Allow with the tenant, sub, backend and Runtime ARN as context; the policy names the method ARN only', async () => {
    const result = await authorizer.authorize(event({ Authorization: `Bearer ${await issuer.mint()}` }), deps());
    expect(effectOf(result)).toBe('Allow');
    expect(result.context).toEqual(CONTEXT);
    expect(result.policyDocument.Statement[0]).toMatchObject({ Resource: METHOD_ARN });
  });

  it('the backend comes from pathParameters.backend, else from the path, else the default backend (ADR-0024)', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    const byParameter = await authorizer.authorize(event({ Authorization: token }, { path: '/billing/invocations', backend: 'billing' }), deps());
    expect(byParameter.context).toMatchObject({ backend: 'billing', runtimeArn: entries.billing.runtimeArn });
    const byPath = await authorizer.authorize(event({ Authorization: token }, { path: '/billing/invocations' }), deps());
    expect(byPath.context).toMatchObject({ backend: 'billing' });
    const bare = await authorizer.authorize(event({ Authorization: token }, { path: '/invocations' }), deps());
    expect(bare.context).toMatchObject({ backend: 'agent', runtimeArn: RUNTIME_ARN });
    const noDefault = await authorizer.authorize(event({ Authorization: token }, { path: '/invocations' }), { ...deps(), defaultBackend: undefined });
    expect(effectOf(noDefault)).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'unknown_backend', status: 404, tenantId: 'tenant-a' });
  });

  it('an unknown or draining backend is an explicit Deny with the reason logged, so the streaming Lambda never starts', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    const unknown = await authorizer.authorize(event({ Authorization: token }, { path: '/nope/invocations', backend: 'nope' }), deps());
    expect(effectOf(unknown)).toBe('Deny');
    expect(unknown.context).toBeUndefined();
    expect(refusal()).toMatchObject({ reason: 'unknown_backend', backend: 'nope', tenantId: 'tenant-a' });
    logs = [];
    const draining = await authorizer.authorize(event({ Authorization: token }, { path: '/old/invocations', backend: 'old' }), deps());
    expect(effectOf(draining)).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'backend_draining', backend: 'old' });
  });

  it('an ill-formed pathParameters.backend is a 404 Deny: the segment is neither looked up nor logged', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    const { registry } = stubRegistry(entries);
    const resolve = jest.spyOn(registry, 'resolve');
    for (const segment of ['Nope', 'a_b', 'a'.repeat(33), '<script>']) {
      logs = [];
      const result = await authorizer.authorize(event({ Authorization: token }, { path: `/${segment}/invocations`, backend: segment }), deps(registry));
      expect(effectOf(result)).toBe('Deny');
      expect(refusal()).toMatchObject({ reason: 'unknown_backend', status: 404, tenantId: 'tenant-a' });
      expect(refusal().backend).toBeUndefined();
      expect(logs.join('\n')).not.toContain(segment);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a registry fault is a Deny with its reason; an unexpected error is a Deny with the error name', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    const faulty: RegistryResolver = {
      resolve: async () => {
        throw new RegistryError('registry_unavailable');
      },
      warm: async () => undefined,
    };
    expect(effectOf(await authorizer.authorize(event({ Authorization: token }), deps(faulty)))).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'registry_unavailable', backend: 'agent' });
    logs = [];
    const broken: RegistryResolver = {
      resolve: async () => {
        throw new TypeError('boom');
      },
      warm: async () => undefined,
    };
    expect(effectOf(await authorizer.authorize(event({ Authorization: token }), deps(broken)))).toBe('Deny');
    expect(logs.map((l) => JSON.parse(l)).find((l) => l.message === 'authorizer failed')).toMatchObject({ error: 'TypeError' });
  });

  it("a token without the backend's requiredScopes is a Deny (403 backend_scope_missing); the ingress-wide floor still applies first", async () => {
    const readOnly = `Bearer ${await issuer.mint({ scope: 'tenant-api/read' })}`;
    const result = await authorizer.authorize(event({ Authorization: readOnly }, { path: '/billing/invocations', backend: 'billing' }), deps());
    expect(effectOf(result)).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'backend_scope_missing', status: 403, backend: 'billing', tenantId: 'tenant-a' });
    // The same token reaches a backend with no scopes of its own.
    expect(effectOf(await authorizer.authorize(event({ Authorization: readOnly }), deps()))).toBe('Allow');
    // The ingress-wide list is the verifier's: a miss there is 'scope_missing', before the registry is consulted.
    const floor = new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], requiredScopes: ['tenant-api/write'] },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );
    logs = [];
    const { registry } = stubRegistry(entries);
    const resolve = jest.spyOn(registry, 'resolve');
    expect(effectOf(await authorizer.authorize(event({ Authorization: readOnly }), { ...deps(registry), verifier: floor }))).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'scope_missing', status: 403 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('denies a missing or non-bearer header without consulting the issuer or the registry, and never logs a header value', async () => {
    const { registry } = stubRegistry(entries);
    const resolve = jest.spyOn(registry, 'resolve');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      for (const headers of [{}, { Authorization: 'Basic x' }] as Record<string, string>[]) {
        expect(effectOf(await authorizer.authorize(event(headers), deps(registry)))).toBe('Deny');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(JSON.parse(logs[0]).reason).toBe('missing_token');
      expect(logs.join('\n')).not.toContain('Basic x');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('awaits deps.ready before verifying (ADR-0023)', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const run = authorizer.authorize(event({ Authorization: `Bearer ${await issuer.mint()}` }), { ...deps(), ready }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    expect(effectOf(await run)).toBe('Allow');
  });
});

describe('handler', () => {
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await testIssuer();
  });

  it('denies with no network: the module-level verifier cannot reach the synthetic issuer', async () => {
    // The module-level verifier fetches the discovery URL; with no reachable
    // issuer every token is refused with an explicit Deny, never an Allow.
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const result = await authorizer.handler({
        type: 'REQUEST',
        methodArn: METHOD_ARN,
        headers: { Authorization: `Bearer ${await issuer.mint()}` },
        path: '/agent/invocations',
        pathParameters: { backend: 'agent' },
      } as unknown as APIGatewayRequestAuthorizerEvent);
      expect(effectOf(result)).toBe('Deny');
      expect(result.context).toBeUndefined();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
