// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { AuthorityError } from '../../src/shared/authority';
import type { IngressConfig } from '../../src/shared/config';
import { publicJwk, signJws } from '../../src/shared/jws';
import { type Admission, TenantLimiter } from '../../src/shared/limits';
import { TRANSACTION_TOKEN_TYPE, transactionClaims } from '../../src/shared/mint';
import { BackendRegistry, RegistryError } from '../../src/shared/registry';
import { type AuthoritySource, ERROR_TEXT, errorBody, forwardedTokenVerifierFor, IngressPipeline, parseBody, pipelineFor, type RegistryResolver, RequestError, type ForwardedTokenVerifier } from '../../src/shared/request';
import { PREFIX_PATTERN, RANDOM_UNIT_ID_PATTERN, sessionPrefix } from '../../src/shared/session';
import { TokenVendingMachine } from '../../src/shared/tvm';
import { TokenVerifier } from '../../src/shared/verifier';
import { baseConfig, CLIENT_ID, DISCOVERY_URL, FIXTURE_ENTRIES, RUNTIME_ARN, stubAuthority, stubForwarded, stubRegistry, testIssuer, TXN_TOKEN, type TestIssuer } from '../helpers';
import { localRsaKey } from '../jws-helpers';

/** The one request contract both ingresses enforce (spec §5, ADR-0002, ADR-0013). */

describe('parseBody', () => {
  const refuse = (fn: () => unknown, reason: string) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).status).toBe(400);
      expect((error as RequestError).reason).toBe(reason);
      return;
    }
    throw new Error('expected a 400');
  };

  it('session off: {prompt} only', () => {
    expect(parseBody('{"prompt":"hello"}', false)).toEqual({ prompt: 'hello' });
    refuse(() => parseBody('{"prompt":"hello","conversationId":"conversationA1x0001"}', false), 'conversation_id_without_session');
  });

  it('session on: {conversationId, prompt}, conversationId validated', () => {
    expect(parseBody('{"prompt":"hello","conversationId":"conversationA1x0001"}', true)).toEqual({
      prompt: 'hello',
      conversationId: 'conversationA1x0001',
    });
    refuse(() => parseBody('{"prompt":"hello"}', true), 'malformed_conversation_id');
    refuse(() => parseBody('{"prompt":"hello","conversationId":"too short"}', true), 'malformed_conversation_id');
    refuse(() => parseBody('{"prompt":"hello","conversationId":42}', true), 'malformed_conversation_id');
  });

  it('prompt must be a string (Runtime input validation)', () => {
    refuse(() => parseBody('{}', false), 'malformed_prompt');
    refuse(() => parseBody('{"prompt":42}', false), 'malformed_prompt');
    refuse(() => parseBody('{"prompt":{"nested":true}}', false), 'malformed_prompt');
    refuse(() => parseBody(null, false), 'malformed_prompt');
  });

  it('malformed JSON and non-object bodies are 400', () => {
    refuse(() => parseBody('not json', false), 'malformed_json');
    refuse(() => parseBody('[1]', false), 'malformed_body');
    refuse(() => parseBody('null', false), 'malformed_body');
  });

  it('error texts are fixed and echo nothing', () => {
    expect(ERROR_TEXT).toEqual({
      400: 'bad request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not found',
      429: 'too many requests',
      502: 'upstream error',
    });
  });
});

describe('IngressPipeline', () => {
  let issuer: TestIssuer;
  const sts = mockClient(STSClient);
  beforeAll(async () => {
    issuer = await testIssuer();
  });
  beforeEach(() => {
    sts.reset();
    sts.on(AssumeRoleCommand).resolves({
      Credentials: { AccessKeyId: 'ASIA-SYNTHETIC', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) },
    });
  });

  const pipeline = (
    config: IngressConfig,
    limiter?: TenantLimiter,
    registry: RegistryResolver = stubRegistry().registry,
    authority: AuthoritySource | null = stubAuthority(),
    forwarded: ForwardedTokenVerifier | null = stubForwarded,
  ) => {
    const verifier = new TokenVerifier(
      {
        discoveryUrl: config.discoveryUrl,
        allowedClientIds: config.allowedClientIds,
        requiredScopes: config.requiredScopes,
        multiTenant: config.multiTenant,
        ownIssuer: config.issuer,
      },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );
    const tvm = config.tvm === undefined ? undefined : new TokenVendingMachine(config.tvm, { sts: new STSClient({}) });
    return new IngressPipeline(config, verifier, registry, tvm, limiter, authority ?? undefined, forwarded ?? undefined);
  };

  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RequestError) {
        return { status: error.status, reason: error.reason };
      }
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('session off: a fresh random unit per request, the minted token, no credentials without tvm (P-2, P-4, P-14)', async () => {
    const p = pipeline(baseConfig());
    const token = await issuer.mint();
    const a = await p.validate({ authorization: `Bearer ${token}`, body: '{"prompt":"hi"}' });
    const b = await p.validate({ authorization: `Bearer ${token}`, body: '{"prompt":"hi"}' });
    expect(a.unitId).toMatch(RANDOM_UNIT_ID_PATTERN);
    expect(a.unitId).not.toBe(b.unitId);
    expect(a).toEqual({
      tenantId: 'tenant-a',
      sub: 'user-a1',
      unitId: a.unitId,
      backend: 'default',
      runtimeArn: RUNTIME_ARN,
      prompt: 'hi',
      transactionToken: TXN_TOKEN,
      txn: 'txn-1',
      grantSize: 2,
      mint: 'miss',
      noToolsGranted: false,
    });
    // The identity token never leaves the ingress (P-14).
    expect(JSON.stringify(a)).not.toContain(token);
    expect(a.credentials).toBeUndefined();
  });

  it("session 'user': the unit is derived from the verified tenant_id|sub and the body's conversationId", async () => {
    const p = pipeline(baseConfig({ sessionScope: 'user' }));
    const body = '{"prompt":"hi","conversationId":"conversationA1x0001"}';
    const a1 = await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body });
    const a2 = await p.validate({ authorization: `Bearer ${await issuer.mint({ sub: 'user-a2' })}`, body });
    const b1 = await p.validate({ authorization: `Bearer ${await issuer.mint({ sub: 'user-b1', tenant_id: 'tenant-b' })}`, body });
    expect(a1.unitId).toBe(`s-${sessionPrefix('tenant-a', 'user-a1', 'user')}-conversationA1x0001`);
    expect(a1.unitId.split('-')[1]).toMatch(PREFIX_PATTERN);
    // Same conversationId, different user or tenant: a different unit (spec §6.3).
    expect(a2.unitId).not.toBe(a1.unitId);
    expect(b1.unitId).not.toBe(a1.unitId);
    // Same user resumes the same unit (integ step 5).
    expect((await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body })).unitId).toBe(a1.unitId);
  });

  it("session 'tenant': two users of one tenant share the unit for one conversationId", async () => {
    const p = pipeline(baseConfig({ sessionScope: 'tenant' }));
    const body = '{"prompt":"hi","conversationId":"conversationA1x0001"}';
    const a1 = await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body });
    const a2 = await p.validate({ authorization: `Bearer ${await issuer.mint({ sub: 'user-a2' })}`, body });
    expect(a2.unitId).toBe(a1.unitId);
  });

  it('token refusals keep the verifier status (401/403) and the body is not read first', async () => {
    const p = pipeline(baseConfig());
    expect(await refusal(p.validate({ body: '{"prompt":"hi"}' }))).toEqual({ status: 401, reason: 'missing_token' });
    expect(await refusal(p.validate({ authorization: 'Basic x', body: '{"prompt":"hi"}' }))).toEqual({ status: 401, reason: 'missing_token' });
    expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint({ tenant_id: undefined })}`, body: 'garbage' }))).toEqual({
      status: 403,
      reason: 'no_tenant',
    });
  });

  it('a conversationId without session is 400 (ADR-0013); a bad one with session is 400', async () => {
    const token = `Bearer ${await issuer.mint()}`;
    expect(await refusal(pipeline(baseConfig()).validate({ authorization: token, body: '{"prompt":"hi","conversationId":"conversationA1x0001"}' }))).toEqual({
      status: 400,
      reason: 'conversation_id_without_session',
    });
    expect(await refusal(pipeline(baseConfig({ sessionScope: 'user' })).validate({ authorization: token, body: '{"prompt":"hi"}' }))).toEqual({
      status: 400,
      reason: 'malformed_conversation_id',
    });
  });

  it('requiredScopes are enforced (ADR-0005)', async () => {
    const p = pipeline(baseConfig({ requiredScopes: ['default/chat'] }));
    expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint({ scope: 'billing/read' })}`, body: '{"prompt":"hi"}' }))).toEqual({
      status: 403,
      reason: 'scope_missing',
    });
    await expect(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' })).resolves.toBeDefined();
  });

  describe('the authority step (v2, spec §3.6)', () => {
    const body = '{"prompt":"hi"}';

    it('mints for the selected tenant, the verified sub and the route backend', async () => {
      const calls: Array<{ tenantId: string; sub: string; agent: string }> = [];
      const p = pipeline(baseConfig(), undefined, stubRegistry(FIXTURE_ENTRIES).registry, stubAuthority(calls));
      await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, path: '/billing/invocations' });
      expect(calls).toEqual([{ tenantId: 'tenant-a', sub: 'user-a1', agent: 'billing' }]);
    });

    it('a refusal keeps its status and reason (agent_not_subscribed 403, mint_failed 502), attributed to the tenant', async () => {
      for (const [status, reason] of [[403, 'agent_not_subscribed'], [403, 'tenant_suspended'], [502, 'grant_too_large'], [502, 'mint_failed']] as const) {
        const refusing: AuthoritySource = {
          resolve: async () => {
            throw new AuthorityError(status, reason);
          },
        };
        let caught: unknown;
        await pipeline(baseConfig(), undefined, undefined, refusing)
          .validate({ authorization: `Bearer ${await issuer.mint()}`, body })
          .catch((e) => (caught = e));
        expect(caught).toMatchObject({ status, reason, tenantId: 'tenant-a' });
      }
    });

    it("api-gateway: the authoriser's token is forwarded, only for the tenant and backend verified here; no authority step runs", async () => {
      const calls: Array<{ tenantId: string; sub: string; agent: string }> = [];
      const p = pipeline(baseConfig(), undefined, undefined, stubAuthority(calls));
      const authorized = { tenantId: 'tenant-a', backend: 'default', transactionToken: 'from-authoriser', txn: 'txn-9', grantSize: 1, mint: 'hit' as const };
      const r = await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized });
      expect(r).toMatchObject({ transactionToken: 'from-authoriser', txn: 'txn-9', grantSize: 1, mint: 'hit' });
      expect(calls).toEqual([]);
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized: { ...authorized, tenantId: 'tenant-b' } }))).toEqual({
        status: 403,
        reason: 'tenant_not_allowed',
      });
      // M-82: the forwarded token itself must verify and name this tenant and agent; a hand-written context cannot.
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized: { ...authorized, transactionToken: 'forged' } }))).toEqual({
        status: 403,
        reason: 'tenant_not_allowed',
      });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized: { ...authorized, transactionToken: 'for-billing' } }))).toEqual({
        status: 403,
        reason: 'tenant_not_allowed',
      });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized: { ...authorized, transactionToken: 'for-tenant-b' } }))).toEqual({
        status: 403,
        reason: 'tenant_not_allowed',
      });
      const unverifiable = pipeline(baseConfig(), undefined, stubRegistry().registry, null, null);
      expect(await refusal(unverifiable.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized }))).toEqual({ status: 502, reason: 'mint_failed' });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, authorized: { ...authorized, backend: 'billing' } }))).toEqual({
        status: 403,
        reason: 'tenant_not_allowed',
      });
    });

    it('neither an authoriser token nor a mint here is 502 mint_failed (a deployment fault)', async () => {
      const p = pipeline(baseConfig(), undefined, undefined, null);
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body }))).toEqual({ status: 502, reason: 'mint_failed' });
    });

    it('the tenant header selects among tenants (ADR-0038); the limit and the mint see the selected tenant', async () => {
      const calls: Array<{ tenantId: string; sub: string; agent: string }> = [];
      const p = pipeline(baseConfig({ multiTenant: true }), undefined, undefined, stubAuthority(calls));
      const token = `Bearer ${await issuer.mint({ tenant_id: undefined, tenants: ['tenant-a', 'tenant-b'] })}`;
      expect((await p.validate({ authorization: token, tenantHeader: 'tenant-b', body })).tenantId).toBe('tenant-b');
      expect(calls.map((c) => c.tenantId)).toEqual(['tenant-b']);
      expect(await refusal(p.validate({ authorization: token, body }))).toEqual({ status: 400, reason: 'tenant_required' });
      expect(await refusal(p.validate({ authorization: token, tenantHeader: 'tenant-c', body }))).toEqual({ status: 403, reason: 'tenant_not_allowed' });
    });

    it('refusal bodies carry the public v2 reason code only (spec §5.1)', () => {
      expect(errorBody(403, 'agent_not_subscribed')).toBe('forbidden: agent_not_subscribed');
      expect(errorBody(400, 'tenant_required')).toBe('bad request: tenant_required');
      expect(errorBody(403, 'scope_missing')).toBe('forbidden');
      expect(errorBody(502, 'mint_failed')).toBe('upstream error');
      expect(errorBody(401)).toBe('unauthorized');
    });
  });

  describe('tvm (P-8)', () => {
    const tvmConfig = baseConfig({ tvm: { roleArn: 'arn:aws:iam::111122223333:role/tenant', includeUserIdTag: false, claimTags: {}, durationSeconds: 900 } });

    it('attaches credentials vended with the verified tenant as the TenantId tag', async () => {
      const p = pipeline(tvmConfig);
      const r = await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' });
      expect(r.credentials?.accessKeyId).toBe('ASIA-SYNTHETIC');
      expect(sts).toHaveReceivedCommandWith(AssumeRoleCommand, { Tags: [{ Key: 'TenantId', Value: 'tenant-a' }] });
    });

    it('a missing claimTags claim is 403; an STS failure is 502', async () => {
      const missing = pipeline(baseConfig({ tvm: { ...tvmConfig.tvm!, claimTags: { Tier: 'custom:tier' } } }));
      expect(await refusal(missing.validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' }))).toEqual({
        status: 403,
        reason: 'claim_missing',
      });
      sts.on(AssumeRoleCommand).rejects(new Error('AccessDenied'));
      expect(await refusal(pipeline(tvmConfig).validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' }))).toEqual({
        status: 502,
        reason: 'tvm_failed',
      });
    });

    it('refuses to be built without a TVM when the config has one', () => {
      const verifier = new TokenVerifier(
        { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
        { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
      );
      expect(() => new IngressPipeline(tvmConfig, verifier, stubRegistry().registry)).toThrow(/TokenVendingMachine/);
    });
  });

  it('pipelineFor builds a verifier, a registry and, with tvm, a TVM from the config', () => {
    const p = pipelineFor(baseConfig());
    expect(p).toBeInstanceOf(IngressPipeline);
    expect(p.registry).toBeInstanceOf(BackendRegistry);
    expect(pipelineFor(baseConfig({ tvm: { roleArn: 'arn:aws:iam::111122223333:role/t', includeUserIdTag: false, claimTags: {}, durationSeconds: 900 } }))).toBeInstanceOf(
      IngressPipeline,
    );
    const { registry } = stubRegistry();
    expect(pipelineFor(baseConfig(), { registry }).registry).toBe(registry);
  });

  describe('backend resolution (ADR-0024)', () => {
    const body = '{"prompt":"hi"}';
    const entries = FIXTURE_ENTRIES;

    it('the route names the backend and the entry supplies the Runtime ARN', async () => {
      const p = pipeline(baseConfig(), undefined, stubRegistry(entries).registry);
      const token = `Bearer ${await issuer.mint()}`;
      const r = await p.validate({ authorization: token, body, path: '/billing/invocations' });
      expect(r.backend).toBe('billing');
      expect(r.runtimeArn).toBe(entries.billing.runtimeArn);
      // The bare route falls back to the default backend.
      expect(await p.validate({ authorization: token, body, path: '/invocations' })).toMatchObject({ backend: 'default', runtimeArn: RUNTIME_ARN });
    });

    it('an unparseable path, an unknown name or a draining backend is 404 with the reason, attributed to the tenant', async () => {
      const p = pipeline(baseConfig(), undefined, stubRegistry(entries).registry);
      const token = `Bearer ${await issuer.mint()}`;
      expect(await refusal(p.validate({ authorization: token, body, path: '/billing/other' }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: token, body, path: '/prod/billing/invocations' }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: token, body, path: '/Billing/invocations' }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: token, body, path: '/nope/invocations' }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: token, body, path: '/old/invocations' }))).toEqual({ status: 404, reason: 'backend_draining' });
      let caught: unknown;
      await p.validate({ authorization: token, body, path: '/nope/invocations' }).catch((e) => (caught = e));
      expect(caught).toMatchObject({ status: 404, tenantId: 'tenant-a' });
    });

    it('no default backend: the bare route is 404', async () => {
      const p = pipeline(baseConfig({ registry: { prefix: '/p/', ttlSeconds: 60 } }), undefined, stubRegistry(entries).registry);
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, path: '/invocations' }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body }))).toEqual({ status: 404, reason: 'unknown_backend' });
    });

    it('requireBackendInPath: the default backend is never consulted, a named backend still resolves', async () => {
      const p = pipeline(baseConfig(), undefined, stubRegistry(entries).registry);
      const token = `Bearer ${await issuer.mint()}`;
      expect(await refusal(p.validate({ authorization: token, body, path: '/invocations', requireBackendInPath: true }))).toEqual({ status: 404, reason: 'unknown_backend' });
      expect(await refusal(p.validate({ authorization: token, body, requireBackendInPath: true }))).toEqual({ status: 404, reason: 'unknown_backend' });
      await expect(p.validate({ authorization: token, body, path: '/billing/invocations', requireBackendInPath: true })).resolves.toMatchObject({ backend: 'billing' });
      await expect(p.validate({ authorization: token, body, path: '/default/invocations', requireBackendInPath: true })).resolves.toMatchObject({ backend: 'default' });
    });

    it('a registry fault is 502 with its reason', async () => {
      const faulty = (reason: 'registry_entry_invalid' | 'registry_unavailable' | 'registry_entry_v1'): RegistryResolver => ({
        resolve: async () => {
          throw new RegistryError(reason);
        },
        warm: async () => undefined,
      });
      for (const reason of ['registry_entry_invalid', 'registry_unavailable', 'registry_entry_v1'] as const) {
        const p = pipeline(baseConfig(), undefined, faulty(reason));
        expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body, path: '/default/invocations' }))).toEqual({ status: 502, reason });
      }
    });

    it('the ingress-wide floor (AND) is checked at the verifier, before the registry (ADR-0005)', async () => {
      const p = pipeline(baseConfig({ requiredScopes: ['default/chat'] }), undefined, stubRegistry(entries).registry);
      // billing/read alone fails the floor at the verifier, not at the backend.
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint({ scope: 'billing/read' })}`, body, path: '/billing/invocations' }))).toEqual({
        status: 403,
        reason: 'scope_missing',
      });
      // The floor plus one billing scope passes billing; the floor alone passes default only.
      await expect(p.validate({ authorization: `Bearer ${await issuer.mint({ scope: 'default/chat billing/invoke' })}`, body, path: '/billing/invocations' })).resolves.toMatchObject({ backend: 'billing' });
      // v2: no per-backend scope check; the floor alone reaches every backend, and the grant rule decides the rest.
      const floorOnly = `Bearer ${await issuer.mint({ scope: 'default/chat' })}`;
      await expect(p.validate({ authorization: floorOnly, body, path: '/billing/invocations' })).resolves.toMatchObject({ backend: 'billing' });
      await expect(p.validate({ authorization: floorOnly, body, path: '/default/invocations' })).resolves.toMatchObject({ backend: 'default' });
    });

    it('the backend is resolved after the token and before the body: a bad token is 401, an unknown route costs no body parse', async () => {
      const p = pipeline(baseConfig(), undefined, stubRegistry().registry);
      expect(await refusal(p.validate({ body: 'garbage', path: '/nope/invocations' }))).toEqual({ status: 401, reason: 'missing_token' });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body: 'garbage', path: '/nope/invocations' }))).toEqual({
        status: 404,
        reason: 'unknown_backend',
      });
    });

    it('warm() pre-fetches the default backend only when one is configured', async () => {
      const withDefault = stubRegistry();
      await pipeline(baseConfig(), undefined, withDefault.registry).warm();
      expect(withDefault.warmed).toEqual(['default']);
      const without = stubRegistry();
      await pipeline(baseConfig({ registry: { prefix: '/p/', ttlSeconds: 60 } }), undefined, without.registry).warm();
      expect(without.warmed).toEqual([]);
    });
  });
  describe('per-tenant limits (ADR-0020)', () => {
    const tvmConfig = baseConfig({ tvm: { roleArn: 'arn:aws:iam::111122223333:role/tenant', includeUserIdTag: false, claimTags: {}, durationSeconds: 900 } });
    const fakeLimiter = (verdict: Admission) => {
      const admitted: string[] = [];
      const limiter = {
        admit: async (tenantId: string) => {
          admitted.push(tenantId);
          return verdict;
        },
        recordOutputTokens: async () => undefined,
      } as unknown as TenantLimiter;
      return { limiter, admitted };
    };

    it('a limited tenant is a 429 tenant_rate_limited carrying the tenantId, and no AssumeRole is made', async () => {
      const { limiter, admitted } = fakeLimiter('limited');
      const p = pipeline(tvmConfig, limiter);
      let caught: unknown;
      try {
        await p.validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RequestError);
      expect(caught).toMatchObject({ status: 429, reason: 'tenant_rate_limited', tenantId: 'tenant-a' });
      expect(admitted).toEqual(['tenant-a']);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 0);
    });

    it('an admitted tenant proceeds to the TVM', async () => {
      const { limiter, admitted } = fakeLimiter('admitted');
      const r = await pipeline(tvmConfig, limiter).validate({ authorization: `Bearer ${await issuer.mint()}`, body: '{"prompt":"hi"}' });
      expect(r.credentials?.accessKeyId).toBe('ASIA-SYNTHETIC');
      expect(admitted).toEqual(['tenant-a']);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 1);
    });

    it('the limit is not checked for a request refused earlier (bad token, bad body)', async () => {
      const { limiter, admitted } = fakeLimiter('limited');
      const p = pipeline(baseConfig(), limiter);
      expect(await refusal(p.validate({ body: '{"prompt":"hi"}' }))).toEqual({ status: 401, reason: 'missing_token' });
      expect(await refusal(p.validate({ authorization: `Bearer ${await issuer.mint()}`, body: 'nope' }))).toEqual({ status: 400, reason: 'malformed_json' });
      expect(admitted).toEqual([]);
    });

    it('pipelineFor builds a limiter only when limits are configured', () => {
      expect(pipelineFor(baseConfig()).limiter).toBeUndefined();
      expect(pipelineFor(baseConfig({ limits: { tableName: 'TenantLimits', requestsPerMinute: 60 } })).limiter).toBeInstanceOf(TenantLimiter);
    });
  });
});

describe('forwardedTokenVerifierFor (M-82)', () => {
  const TXN_ISSUER = 'https://example.execute-api.eu-central-1.amazonaws.com/prod';
  const key = localRsaKey();
  const jwks = JSON.stringify({ keys: [publicJwk(key.publicKey, 'gen-1')] });
  const mintFor = (agent: string, extra: Record<string, unknown> = {}, typ = TRANSACTION_TOKEN_TYPE, kid = 'gen-1') =>
    signJws(
      { alg: 'RS256', typ, kid },
      { ...transactionClaims({ tenantId: 'tenant-a', sub: 'u', agent, scope: `${agent}/chat`, gateways: [], versions: { tenant: 1, agent: 1 } }, { issuer: TXN_ISSUER, ttlSeconds: 300, ingressRoleArn: 'arn:aws:iam::111122223333:role/ingress' }, Math.floor(Date.now() / 1000), { txn: 't', jti: 'j' }), ...extra },
      key.signer,
    );

  it('verifies a token against the deployed JWKS document without a fetch and returns its tenant and agent', async () => {
    const verify = forwardedTokenVerifierFor(TXN_ISSUER, jwks);
    expect(await verify(await mintFor('default'))).toEqual({ tenantId: 'tenant-a', agent: 'default' });
    expect(await verify(await mintFor('billing'))).toEqual({ tenantId: 'tenant-a', agent: 'billing' });
  });

  it('refuses another typ, another issuer, a missing exp, or an unknown kid (the route fetch fails in a unit test)', async () => {
    const verify = forwardedTokenVerifierFor(TXN_ISSUER, jwks);
    await expect(verify(await mintFor('default', {}, 'at+jwt'))).rejects.toThrow();
    await expect(verify(await mintFor('default', { iss: 'https://other.example.com' }))).rejects.toThrow();
    await expect(verify(await mintFor('default', { exp: undefined }))).rejects.toThrow();
    await expect(verify(await mintFor('default', {}, TRANSACTION_TOKEN_TYPE, 'gen-2'))).rejects.toThrow();
    await expect(verify('not-a-token')).rejects.toThrow();
  });
});
