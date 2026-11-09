// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { AuthorityError } from '../../src/shared/authority';
import { ENV } from '../../src/shared/config';
import { RegistryError } from '../../src/shared/registry';
import type { RegistryResolver } from '../../src/shared/request';
import { TokenVerifier } from '../../src/shared/verifier';
import { CLIENT_ID, DISCOVERY_URL, FIXTURE_ENTRIES, REGISTRY_PREFIX, RUNTIME_ARN, stubAuthority, stubRegistry, testIssuer, TXN_TOKEN, type TestIssuer } from '../helpers';

process.env[ENV.INGRESS] = 'api-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
process.env[ENV.REGISTRY_PREFIX] = REGISTRY_PREFIX;
// v2: the authoriser mints, so its environment names the signing key, the issuer and the store.
process.env[ENV.TXN_KEY_ID] = '1234abcd-12ab-34cd-56ef-1234567890ab';
process.env[ENV.ISSUER] = 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod';
process.env[ENV.INGRESS_ROLE_ARN] = 'arn:aws:iam::111122223333:role/ingress';
process.env[ENV.ENTITLEMENTS_TABLE] = 'Entitlements';
// No default backend: the module-level registry makes no SSM call at load.
delete process.env[ENV.DEFAULT_BACKEND];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const authorizer = require('../../src/ingress/api-gateway-authorizer.function') as typeof import('../../src/ingress/api-gateway-authorizer.function');

/** The Lambda authoriser (spec C-3a, ADR-0024): Allow with {tenantId, sub, backend, runtimeArn} context, explicit Deny otherwise. */
const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123/prod/POST/default/invocations';
const CONTEXT = { tenantId: 'tenant-a', sub: 'user-a1', backend: 'default', runtimeArn: RUNTIME_ARN, transactionToken: TXN_TOKEN, txn: 'txn-1', grantSize: '2', mint: 'miss' as const };

const effectOf = (result: { policyDocument: { Statement: unknown[] } }) => (result.policyDocument.Statement[0] as { Effect: string }).Effect;

describe('buildPolicy', () => {
  it('Allow carries the verified tenant and the resolved backend as context for the access log (P-9)', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Allow', CONTEXT);
    expect(result.principalId).toBe('user-a1');
    expect(result.policyDocument.Statement[0]).toEqual({ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN });
    expect(result.context).toEqual(CONTEXT);
  });

  it('Deny carries no context, or only a public v2 reason code for the ACCESS_DENIED template (spec §5.1)', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Deny');
    expect(result.principalId).toBe('unauthorized');
    expect(effectOf(result)).toBe('Deny');
    expect(result.context).toBeUndefined();
    expect(authorizer.buildPolicy(METHOD_ARN, 'Deny', undefined, 'agent_not_subscribed').context).toEqual({ reason: 'agent_not_subscribed', reasonSuffix: ': agent_not_subscribed' });
    expect(authorizer.buildPolicy(METHOD_ARN, 'Deny', undefined, 'invalid_token').context).toBeUndefined();
  });
});

describe('authorize', () => {
  let issuer: TestIssuer;
  let verifier: TokenVerifier;
  let logs: string[];
  let spy: jest.SpyInstance;
  const entries = {
    billing: FIXTURE_ENTRIES.billing,
    old: FIXTURE_ENTRIES.old,
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

  const deps = (registry: RegistryResolver = stubRegistry(entries).registry, authority = stubAuthority()) => ({ verifier, registry, authority, defaultBackend: 'default' });
  const event = (headers: Record<string, string>, route: { path?: string; backend?: string } = { path: '/default/invocations', backend: 'default' }): APIGatewayRequestAuthorizerEvent =>
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
    expect(bare.context).toMatchObject({ backend: 'default', runtimeArn: RUNTIME_ARN });
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
    expect(refusal()).toMatchObject({ reason: 'registry_unavailable', backend: 'default' });
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

  it('v2: an entitlement refusal is a Deny carrying its public reason; the floor still applies first, before the registry (ADR-0005)', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    const refusing = {
      resolve: async () => {
        throw new AuthorityError(403, 'agent_not_subscribed');
      },
    };
    const denied = await authorizer.authorize(event({ Authorization: token }), deps(undefined, refusing));
    expect(effectOf(denied)).toBe('Deny');
    expect(denied.context).toEqual({ reason: 'agent_not_subscribed', reasonSuffix: ': agent_not_subscribed' });
    expect(refusal()).toMatchObject({ reason: 'agent_not_subscribed', status: 403, tenantId: 'tenant-a', backend: 'default' });
    const floor = new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], requiredScopes: ['app/use'] },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );
    logs = [];
    const { registry } = stubRegistry(entries);
    const resolve = jest.spyOn(registry, 'resolve');
    expect(effectOf(await authorizer.authorize(event({ Authorization: token }), { ...deps(registry), verifier: floor }))).toBe('Deny');
    expect(refusal()).toMatchObject({ reason: 'scope_missing', status: 403 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('v2: the authority step gets the selected tenant (X-Tenant-Id) and the route backend; the token never reaches a log line', async () => {
    const calls: Array<{ tenantId: string; sub: string; agent: string }> = [];
    const multi = new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], multiTenant: true },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );
    const token = `Bearer ${await issuer.mint({ tenant_id: undefined, tenants: ['tenant-a', 'tenant-b'] })}`;
    const result = await authorizer.authorize(event({ 'Authorization': token, 'X-Tenant-Id': 'tenant-b' }, { path: '/billing/invocations', backend: 'billing' }), {
      ...deps(undefined, stubAuthority(calls)),
      verifier: multi,
    });
    expect(effectOf(result)).toBe('Allow');
    expect(calls).toEqual([{ tenantId: 'tenant-b', sub: 'user-a1', agent: 'billing' }]);
    expect(logs.join('\n')).not.toContain(TXN_TOKEN);
    expect(logs.map((l) => JSON.parse(l)).find((l) => l.message === 'request authorised')).toMatchObject({ tenantId: 'tenant-b', agent: 'billing', txn: 'txn-1', grantSize: 2, mint: 'miss' });
    const missing = await authorizer.authorize(event({ Authorization: token }), { ...deps(), verifier: multi });
    expect(missing.context).toEqual({ reason: 'tenant_required', reasonSuffix: ': tenant_required' });
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
        path: '/default/invocations',
        pathParameters: { backend: 'default' },
      } as unknown as APIGatewayRequestAuthorizerEvent);
      expect(effectOf(result)).toBe('Deny');
      expect(result.context).toBeUndefined();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe('authorize on /{backend}/delegations (ADR-0048)', () => {
  const DELEGATION_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123/prod/POST/billing/delegations';
  const caller = { tenantId: 'tenant-a', sub: 'user-a1', agent: 'default', chain: [], act: { sub: 'arn:aws:iam::111122223333:role/ingress' }, txn: 'txn-caller' };
  const verify = async (token: string | undefined) => {
    if (token === 'caller-token') {
      return caller;
    }
    throw new Error('token_invalid');
  };
  const delegating = (calls: unknown[] = []) => ({
    resolve: stubAuthority().resolve,
    delegate: async (c: unknown, target: string, _t: unknown, _c: unknown, maxDepth: number) => {
      calls.push({ c, target, maxDepth });
      return { token: 'replacement', txn: 'txn-caller', exp: 1, mint: 'miss' as const, grantSize: 3, noToolsGranted: false };
    },
  });
  const event = (authorization: string | undefined, path = '/billing/delegations', backend = 'billing'): APIGatewayRequestAuthorizerEvent =>
    ({
      type: 'REQUEST',
      methodArn: DELEGATION_ARN,
      path,
      pathParameters: { backend },
      headers: authorization === undefined ? {} : { authorization },
      requestContext: {},
    }) as unknown as APIGatewayRequestAuthorizerEvent;
  const deps = (overrides: Partial<Parameters<typeof authorizer.authorize>[1]> = {}) => ({
    verifier: { verify: async () => { throw new Error('the identity verifier must not run on the delegation route'); } } as never,
    registry: stubRegistry({ billing: FIXTURE_ENTRIES.billing }).registry,
    authority: delegating(),
    delegation: { config: { maxDepth: 2 }, verify },
    ...overrides,
  });
  let logs: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    logs = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((line: string | Uint8Array) => (logs.push(String(line)), true));
  });
  afterEach(() => spy.mockRestore());

  it('Allow with the target as backend, the replacement token, the caller txn, delegatedFrom and depth; logs delegation admitted, never the token', async () => {
    const calls: unknown[] = [];
    const result = await authorizer.authorize(event('Bearer caller-token'), deps({ authority: delegating(calls) }));
    expect(effectOf(result)).toBe('Allow');
    expect(result.context).toEqual({
      tenantId: 'tenant-a',
      sub: 'user-a1',
      backend: 'billing',
      runtimeArn: FIXTURE_ENTRIES.billing.runtimeArn,
      transactionToken: 'replacement',
      txn: 'txn-caller',
      grantSize: '3',
      mint: 'miss',
      delegatedFrom: 'default',
      depth: '1',
    });
    expect(calls[0]).toMatchObject({ target: 'billing', maxDepth: 2, c: { agent: 'default' } });
    const line = JSON.parse(logs.find((l) => l.includes('delegation admitted'))!);
    expect(line).toMatchObject({ tenantId: 'tenant-a', from: 'default', to: 'billing', depth: 1, txn: 'txn-caller', route: 'delegations' });
    expect(logs.join('')).not.toContain('replacement');
  });

  it('an identity token or no bearer is Deny with no public reason (401 in the log)', async () => {
    for (const authorization of [undefined, 'Bearer an-identity-token', 'Basic x']) {
      const result = await authorizer.authorize(event(authorization), deps());
      expect(effectOf(result)).toBe('Deny');
      expect(result.context).toBeUndefined();
    }
    expect(logs.filter((l) => l.includes('delegation refused') && l.includes('token_invalid'))).toHaveLength(3);
  });

  it('an undeclared target is delegation_not_declared before any lookup; a declared target without an entry is Deny (404 in the log); the three delegation refusals carry their public reason', async () => {
    const undeclared = await authorizer.authorize(event('Bearer caller-token', '/nobody/delegations', 'nobody'), deps());
    expect(effectOf(undeclared)).toBe('Deny');
    expect(undeclared.context).toEqual({ reason: 'delegation_not_declared', reasonSuffix: ': delegation_not_declared' });
    expect(logs.some((l) => l.includes('unknown_backend'))).toBe(false);
    const declaredButGone = stubRegistry({ default: { ...FIXTURE_ENTRIES.billing, needs: ['default/chat'], delegatesTo: ['gone'] } }).registry;
    const unknown = await authorizer.authorize(event('Bearer caller-token', '/gone/delegations', 'gone'), deps({ registry: declaredButGone }));
    expect(effectOf(unknown)).toBe('Deny');
    expect(logs.some((l) => l.includes('unknown_backend'))).toBe(true);
    for (const reason of ['delegation_not_declared', 'delegation_depth', 'delegation_loop'] as const) {
      const refusing = { resolve: stubAuthority().resolve, delegate: async () => { throw new AuthorityError(403, reason); } };
      const result = await authorizer.authorize(event('Bearer caller-token'), deps({ authority: refusing }));
      expect(effectOf(result)).toBe('Deny');
      expect(result.context).toEqual({ reason, reasonSuffix: `: ${reason}` });
    }
  });

  it('without the delegation module the route is Deny and logged as a deployment fault', async () => {
    const result = await authorizer.authorize(event('Bearer caller-token'), deps({ delegation: undefined }));
    expect(effectOf(result)).toBe('Deny');
    expect(logs.some((l) => l.includes('delegation_unavailable'))).toBe(true);
  });
});
