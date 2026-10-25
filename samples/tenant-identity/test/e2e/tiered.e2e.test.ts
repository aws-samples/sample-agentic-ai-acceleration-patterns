// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ADR-0027 acceptance scenario for the `tiered` deployment, run against the
 * deployed `TenantIdentity-tiered` stack. The three single-topology stacks
 * run the spec §10 scenario unchanged (`scenario.ts`); this file covers only
 * what `tiered` adds: the `tier` field, one usage plan per tier, a standard
 * tenant in the shared pool next to a premium tenant in its own pool, and
 * the binding rule (a tenant is reachable only through its own pool).
 *
 * Same contract as `scenario.ts`: the test is the client (spec §3.2). It
 * obtains tokens through the `IssueToken` test aid (ADR-0006), narrows them
 * through `POST /oauth2/token` (ADR-0009), verifies every token it asserts on
 * against the pool that issued it, and never prints a token, refresh token,
 * or password (spec N-4/N-6/N-7); failed assertions surface claim names,
 * usernames, and tenant ids only.
 *
 * Skipped like the others: set `E2E_TOPOLOGIES` to a list without `tiered`.
 */

import {
  APIGatewayClient,
  GetApiKeyCommand,
  GetApiKeysCommand,
  GetUsagePlanKeyCommand,
} from '@aws-sdk/client-api-gateway';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListTagsForResourceCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  AccessTokenVerifier,
  CreateTenantOutput,
  discoverStack,
  ExchangeClient,
  HttpResult,
  PlatformClient,
  region,
  StackOutputs,
  TenantClient,
} from './clients';
import { emailFor, expectStatus, newRunId, Tokens, topologyEnabled } from './scenario';
import {
  apiKeyName,
  COGNITO_USER_ADMIN_SCOPE,
  SCOPE_TENANT_ADMIN,
  TENANT_ATTRIBUTE,
  TENANT_POOL_NAME_PREFIX,
  TENANT_TAG_KEY,
  tenantResource,
  TIERED,
  TIER_TOPOLOGY,
} from '../../src/shared/constants';

const run = topologyEnabled(TIERED) ? describe : describe.skip;

run(`ADR-0027 scenario — ${TIERED}`, () => {
  jest.setTimeout(900_000);

  const runId = newRunId();

  let stack: StackOutputs;
  let platform: PlatformClient;
  let exchange: ExchangeClient;
  let tenant: TenantClient;
  let cognito: CognitoIdentityProviderClient;
  let apigw: APIGatewayClient;

  /** The shared pool, from the stack outputs: every standard tenant's issuer. */
  let sharedVerifier: AccessTokenVerifier;
  /** P's own pool, from GetTenant: built once P exists. */
  let premiumVerifier: AccessTokenVerifier;

  // State threaded through the sequential steps. S = standard, P = premium.
  // S2 is a second standard tenant created in step b and deliberately left
  // behind (see step h).
  const tenantIds: Record<string, string> = {}; // S, P, S2
  let premium: { userPoolId: string; appClientId: string; issuer: string };
  const usernames: Record<string, string> = {}; // s1 (S admin), p1 (P admin), u (in S), v (in P)
  const tokens: Record<string, Tokens> = {}; // u, v, s1, p1
  const narrowedAdmin: Record<string, string> = {}; // S, P
  const apiKeyIds: Record<string, string> = {}; // S, P

  /** ADR-0025: the keys named tenant-<id>; GetApiKeys' nameQuery is a prefix match. */
  async function keysNamedFor(tenantId: string): Promise<{ id?: string; enabled?: boolean }[]> {
    const res = await apigw.send(new GetApiKeysCommand({ nameQuery: apiKeyName(tenantId), includeValues: false }));
    return (res.items ?? []).filter((k) => k.name === apiKeyName(tenantId));
  }

  /** True when `keyId` is a member of usage plan `planId`. */
  async function keyInPlan(planId: string, keyId: string): Promise<boolean> {
    try {
      const res = await apigw.send(new GetUsagePlanKeyCommand({ usagePlanId: planId, keyId }));
      return res.id === keyId;
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFoundException') {
        return false;
      }
      throw error;
    }
  }

  async function issueToken(tenantKey: string, who: string): Promise<Tokens> {
    const res = await platform.call<Tokens>(
      'POST',
      `platform/tenants/${tenantIds[tenantKey]}/users/${usernames[who]}/token`,
      { password: 'Synthetic-Pass-1!' },
    );
    expectStatus(res, 200, `IssueToken ${who}`);
    return { accessToken: res.body.accessToken, idToken: res.body.idToken, refreshToken: res.body.refreshToken };
  }

  async function createUser(tenantKey: string, who: string): Promise<string> {
    const res = await platform.call<{ user: { username: string } }>(
      'POST',
      `platform/tenants/${tenantIds[tenantKey]}/users`,
      { email: emailFor(runId, who), admin: false },
    );
    expectStatus(res, 201, `CreateUser ${who} in ${tenantKey}`);
    return res.body.user.username;
  }

  /** The exchange client_id a tenant's users present: the shared client (S) or P's own. */
  function exchangeClientId(tenantKey: 'S' | 'P'): string {
    return tenantKey === 'P' ? premium.appClientId : stack.appClientId!;
  }

  function verifierFor(tenantKey: 'S' | 'P'): AccessTokenVerifier {
    return tenantKey === 'P' ? premiumVerifier : sharedVerifier;
  }

  /** Asserts an exchange was refused with an RFC 6749 error, never a token. */
  function expectOAuthRefusal(result: HttpResult, allowed: string[], ctx: string): void {
    expectStatus(result, 400, ctx);
    expect(allowed).toContain(result.oauthError);
    expect((result.body as Record<string, unknown> | undefined)?.access_token).toBeUndefined();
  }

  // -- setup ----------------------------------------------------------------
  beforeAll(async () => {
    stack = await discoverStack(TIERED);
    platform = new PlatformClient(stack.apiUrl);
    exchange = new ExchangeClient(stack.apiUrl);
    tenant = new TenantClient(stack.apiUrl);
    cognito = new CognitoIdentityProviderClient({ region: region() });
    apigw = new APIGatewayClient({ region: region() });
    // tiered publishes the shared pool (standard tier) and both plans.
    expect(stack.userPoolId).toBeDefined();
    expect(stack.appClientId).toBeDefined();
    expect(stack.tenantUsagePlanId).toBeDefined();
    expect(stack.premiumUsagePlanId).toBeDefined();
    expect(stack.tenantScopedRoleArn).toBeDefined(); // ADR-0026, for premium tenants
    sharedVerifier = AccessTokenVerifier.forPool(stack.userPoolId!, stack.appClientId!);
  });

  // Best-effort cleanup of S and P so a failed run leaves nothing behind
  // (spec P-4). S2 is excluded on purpose: the stack drain must offboard it.
  afterAll(async () => {
    for (const key of ['S', 'P']) {
      if (tenantIds[key] === undefined) {
        continue;
      }
      try {
        await platform.call('DELETE', `platform/tenants/${tenantIds[key]}`);
      } catch {
        // best effort
      }
    }
  });

  // -- a: tier is required, never defaulted (P-7 as amended) -----------------
  test('a: CreateTenant without tier → 400 InvalidInput', async () => {
    const res = await platform.createTenant({ name: `${runId}-no-tier`, adminEmail: emailFor(runId, 'no-tier') });
    expectStatus(res, 400, 'CreateTenant without tier');
    expect((res.body as unknown as { reason?: string }).reason).toBe('InvalidInput');
    expect(res.body?.tenant).toBeUndefined();
  });

  // -- b: one tenant per tier -------------------------------------------------
  test('b: CreateTenant S (standard) and P (premium): tier echoed, S in the shared pool, P in its own', async () => {
    const create = async (key: string, who: string, tier: 'standard' | 'premium'): Promise<CreateTenantOutput> => {
      const res = await platform.createTenant({ name: `${runId}-${key}`, adminEmail: emailFor(runId, who), tier });
      expectStatus(res, 201, `CreateTenant ${key} (${tier})`);
      expect(res.body.tenant.status).toBe('ACTIVE');
      expect(res.body.tenant.tier).toBe(tier);
      expect(res.body.tenant.topology).toBe(TIER_TOPOLOGY[tier]);
      expect(typeof res.body.admin.temporaryPassword).toBe('string');
      tenantIds[key] = res.body.tenant.tenantId;
      usernames[who] = res.body.admin.user.username;
      return res.body;
    };

    const s = await create('S', 's1', 'standard');
    expect(s.tenant.userPoolId).toBeUndefined(); // the shared pool is the stack's, not the row's
    expect(s.tenant.appClientId).toBeUndefined();
    expect(s.tenant.issuer).toBeUndefined();
    expect(s.tenant.groupName).toBeUndefined(); // shared-pool, not shared-pool-multi-tenant

    const p = await create('P', 'p1', 'premium');
    expect(p.tenant.userPoolId).toBeDefined();
    expect(p.tenant.userPoolId).not.toBe(stack.userPoolId);
    expect(p.tenant.appClientId).toBeDefined();
    expect(p.tenant.appClientId).not.toBe(stack.appClientId);
    expect(p.tenant.issuer).toBeDefined();
    expect(p.tenant.issuer!.endsWith(`/${p.tenant.userPoolId}`)).toBe(true);
    premium = { userPoolId: p.tenant.userPoolId!, appClientId: p.tenant.appClientId!, issuer: p.tenant.issuer! };
    premiumVerifier = AccessTokenVerifier.forIssuer(premium.issuer, premium.appClientId);

    // S2: a second standard tenant, left behind on purpose (step h).
    await create('S2', 's2', 'standard');

    // GetTenant returns the tier too, and ListTenants shows both tiers in one registry.
    for (const [key, tier] of [
      ['S', 'standard'],
      ['P', 'premium'],
    ] as const) {
      const got = await platform.call<{ tenant: { tier?: string; topology?: string; userPoolId?: string } }>(
        'GET',
        `platform/tenants/${tenantIds[key]}`,
      );
      expectStatus(got, 200, `GetTenant ${key}`);
      expect(got.body.tenant.tier).toBe(tier);
      expect(got.body.tenant.topology).toBe(TIER_TOPOLOGY[tier]);
      expect(got.body.tenant.userPoolId).toBe(key === 'P' ? premium.userPoolId : undefined);
    }
    const list = await platform.call<{ tenants: { tenantId: string; tier?: string }[] }>('GET', 'platform/tenants');
    expectStatus(list, 200, 'ListTenants');
    const tiers = new Map(list.body.tenants.map((t) => [t.tenantId, t.tier]));
    expect(tiers.get(tenantIds.S)).toBe('standard');
    expect(tiers.get(tenantIds.P)).toBe('premium');
    expect(tiers.get(tenantIds.S2)).toBe('standard');

    // P's pool is a sample pool with the trigger attached and tagged for P
    // (ADR-0026), exactly as in pool-per-tenant.
    const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: premium.userPoolId }));
    expect(pool.UserPool?.Name?.startsWith(TENANT_POOL_NAME_PREFIX)).toBe(true);
    expect(
      pool.UserPool?.LambdaConfig?.PreTokenGenerationConfig?.LambdaArn ?? pool.UserPool?.LambdaConfig?.PreTokenGeneration,
    ).toBeDefined();
    const tags = (await cognito.send(new ListTagsForResourceCommand({ ResourceArn: pool.UserPool!.Arn! }))).Tags ?? {};
    expect(tags[TENANT_TAG_KEY]).toBe(tenantIds.P);
  });

  // -- c: one usage plan per tier (ADR-0025, ADR-0027) ------------------------
  test('c: S’s API key is in the standard plan and P’s in the premium plan, not the other way round', async () => {
    for (const key of ['S', 'P']) {
      const named = await keysNamedFor(tenantIds[key]);
      expect(named).toHaveLength(1);
      expect(named[0].enabled).toBe(true);
      apiKeyIds[key] = named[0].id!;
    }
    expect(apiKeyIds.S).not.toBe(apiKeyIds.P);
    const standardPlan = stack.tenantUsagePlanId!;
    const premiumPlan = stack.premiumUsagePlanId!;
    expect(standardPlan).not.toBe(premiumPlan);
    expect(await keyInPlan(standardPlan, apiKeyIds.S)).toBe(true);
    expect(await keyInPlan(premiumPlan, apiKeyIds.S)).toBe(false);
    expect(await keyInPlan(premiumPlan, apiKeyIds.P)).toBe(true);
    expect(await keyInPlan(standardPlan, apiKeyIds.P)).toBe(false);
  });

  // -- d: token contract per tier (P-6) --------------------------------------
  test('d: u (in S) and v (in P) get tenant_id from their own pool; verified against that pool', async () => {
    usernames.u = await createUser('S', 'u');
    usernames.v = await createUser('P', 'v');
    tokens.u = await issueToken('S', 'u');
    tokens.v = await issueToken('P', 'v');

    const uClaims = await sharedVerifier.verify(tokens.u.accessToken);
    expect(uClaims.tenant_id).toBe(tenantIds.S);
    expect(uClaims.iss).toBe(sharedVerifier.issuer);
    expect(uClaims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
    expect(uClaims.tenants).toBeUndefined();

    const vClaims = await premiumVerifier.verify(tokens.v.accessToken);
    expect(vClaims.tenant_id).toBe(tenantIds.P);
    expect(vClaims.iss).toBe(premium.issuer);
    expect(vClaims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
    expect(vClaims.tenants).toBeUndefined();

    // The wrong pool's verifier refuses each token: the issuers differ.
    await expect(premiumVerifier.verify(tokens.u.accessToken)).rejects.toBeDefined();
    await expect(sharedVerifier.verify(tokens.v.accessToken)).rejects.toBeDefined();
  });

  // -- e: narrowing and the tenant admin door per tier (P-10, P-11) ------------
  test('e: each tenant admin narrows through its own client and manages only its own tenant', async () => {
    tokens.s1 = await issueToken('S', 's1');
    tokens.p1 = await issueToken('P', 'p1');

    for (const key of ['S', 'P'] as const) {
      const who = key === 'S' ? 's1' : 'p1';
      const res = await exchange.exchange({
        clientId: exchangeClientId(key),
        subjectToken: tokens[who].refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(tenantIds[key]),
      });
      expectStatus(res, 200, `exchange ${who} admin@${key}`);
      narrowedAdmin[key] = (res.body as { access_token: string }).access_token;
      const claims = await verifierFor(key).verify(narrowedAdmin[key]);
      expect(claims.tenant_id).toBe(tenantIds[key]);
      expect(String(claims.scope).split(' ')).toContain(SCOPE_TENANT_ADMIN);
      expect(String(claims.scope)).not.toContain(COGNITO_USER_ADMIN_SCOPE);
      expect(claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
    }

    // ListTenantUsers through each door (TenantClient retries the gateway's
    // 403 while a fresh key propagates, ADR-0025).
    const listS = await tenant.call<{ users: { username: string }[] }>('GET', 'tenant/users', narrowedAdmin.S);
    expectStatus(listS, 200, 'ListTenantUsers S');
    const inS = new Set(listS.body.users.map((x) => x.username));
    expect(inS.has(usernames.s1)).toBe(true);
    expect(inS.has(usernames.u)).toBe(true);
    expect(inS.has(usernames.p1)).toBe(false);
    expect(inS.has(usernames.v)).toBe(false);
    expect(inS.has(usernames.s2)).toBe(false); // the other standard tenant in the same pool

    const listP = await tenant.call<{ users: { username: string }[] }>('GET', 'tenant/users', narrowedAdmin.P);
    expectStatus(listP, 200, 'ListTenantUsers P');
    const inP = new Set(listP.body.users.map((x) => x.username));
    expect(inP.has(usernames.p1)).toBe(true);
    expect(inP.has(usernames.v)).toBe(true);
    expect(inP.has(usernames.s1)).toBe(false);
    expect(inP.has(usernames.u)).toBe(false);

    // Un-narrowed tokens hold no tenant-admin/users, in either tier → 403.
    expectStatus(await tenant.call('GET', 'tenant/users', tokens.s1.accessToken), 403, 'un-narrowed s1 → 403');
    expectStatus(await tenant.call('GET', 'tenant/users', tokens.p1.accessToken), 403, 'un-narrowed p1 → 403');
  });

  // -- f: the binding rule across tiers (ADR-0027) ---------------------------
  test('f: a tenant is reachable only through its own pool: cross-tier reads 404, cross-tier exchanges fail', async () => {
    // The tenant comes from the token, so P's admin asking for S's user by
    // name gets 404 (R-12), and S's admin for P's user likewise. Neither
    // token can name the other tenant.
    expectStatus(await tenant.call('GET', `tenant/users/${usernames.u}`, narrowedAdmin.P), 404, 'P admin → u (in S)');
    expectStatus(await tenant.call('DELETE', `tenant/users/${usernames.u}`, narrowedAdmin.P), 404, 'P admin deletes u');
    expectStatus(await tenant.call('GET', `tenant/users/${usernames.v}`, narrowedAdmin.S), 404, 'S admin → v (in P)');
    expectStatus(await tenant.call('DELETE', `tenant/users/${usernames.v}`, narrowedAdmin.S), 404, 'S admin deletes v');
    expectStatus(await platform.call('GET', `platform/tenants/${tenantIds.S}/users/${usernames.u}`), 200, 'u untouched');
    expectStatus(await platform.call('GET', `platform/tenants/${tenantIds.P}/users/${usernames.v}`), 200, 'v untouched');

    // u's refresh token (shared pool) presented with P's client_id: Cognito
    // refuses a refresh token from another pool's client, so the exchange
    // answers an OAuth error (invalid_grant; invalid_client when the endpoint
    // refuses the client first) and never a token.
    expectOAuthRefusal(
      await exchange.exchange({
        clientId: exchangeClientId('P'),
        subjectToken: tokens.u.refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(tenantIds.P),
      }),
      ['invalid_grant', 'invalid_client'],
      'exchange u with P’s client_id',
    );
    // And the reverse: v's refresh token (P's pool) with the shared client_id.
    expectOAuthRefusal(
      await exchange.exchange({
        clientId: exchangeClientId('S'),
        subjectToken: tokens.v.refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(tenantIds.S),
      }),
      ['invalid_grant', 'invalid_client'],
      'exchange v with the shared client_id',
    );
    // A client_id that belongs to no tenant at all.
    expectOAuthRefusal(
      await exchange.exchange({
        clientId: `${exchangeClientId('P')}x`,
        subjectToken: tokens.v.refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(tenantIds.P),
      }),
      ['invalid_grant', 'invalid_client'],
      'exchange v with an unknown client_id',
    );

    // Naming the other tenant as the resource, with the right client, is
    // refused by the trigger (invalid_target): u holds only S, v only P.
    const uForP = await exchange.exchange({
      clientId: exchangeClientId('S'),
      subjectToken: tokens.u.refreshToken,
      scope: SCOPE_TENANT_ADMIN,
      resource: tenantResource(tenantIds.P),
    });
    expectOAuthRefusal(uForP, ['invalid_target'], 'exchange u resource=P');
    const vForS = await exchange.exchange({
      clientId: exchangeClientId('P'),
      subjectToken: tokens.v.refreshToken,
      scope: SCOPE_TENANT_ADMIN,
      resource: tenantResource(tenantIds.S),
    });
    expectOAuthRefusal(vForS, ['invalid_target'], 'exchange v resource=S');
  });

  // -- f2: the binding rule at the trigger (ADR-0027, spec §10 step 12) -------
  test('f2: a shared-pool user whose custom:tenantId names premium P cannot get a token', async () => {
    // Simulates a vendor bug: a user written straight into the shared pool
    // (bypassing the platform API) with a premium tenant's id. The trigger
    // finds P's row is pool-per-tenant and throws invalid_target:
    // pool_mismatch, so Cognito fails the sign-in.
    const email = emailFor(runId, 'binding-bypass');
    const password = 'Synthetic-Pass-1!';
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: stack.userPoolId!,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: TENANT_ATTRIBUTE, Value: tenantIds.P },
        ],
      }),
    );
    try {
      await cognito.send(
        new AdminSetUserPasswordCommand({ UserPoolId: stack.userPoolId!, Username: email, Password: password, Permanent: true }),
      );
      let refused: Error | undefined;
      try {
        await cognito.send(
          new AdminInitiateAuthCommand({
            UserPoolId: stack.userPoolId!,
            ClientId: stack.appClientId!,
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: email, PASSWORD: password },
          }),
        );
      } catch (error) {
        refused = error as Error;
      }
      expect(refused?.name).toBe('UserLambdaValidationException');
      expect(refused?.message).toContain('pool_mismatch');
    } finally {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: stack.userPoolId!, Username: email }));
    }
  });

  // -- g: tier has no meaning outside tiered (P-4) ----------------------------
  // Runs against the shared-pool stack, so only when that stack is enabled.
  (topologyEnabled('shared-pool') ? test : test.skip)(
    'g: a single-topology stack refuses tier → 400 UnsupportedInTopology',
    async () => {
      const single = await discoverStack('shared-pool');
      const client = new PlatformClient(single.apiUrl);
      for (const tier of ['standard', 'premium'] as const) {
        const res = await client.createTenant({
          name: `${runId}-tier-refused`,
          adminEmail: emailFor(runId, `tier-refused-${tier}`),
          tier,
        });
        expectStatus(res, 400, `CreateTenant tier=${tier} on shared-pool`);
        expect((res.body as unknown as { reason?: string }).reason).toBe('UnsupportedInTopology');
        expect(res.body?.tenant).toBeUndefined();
      }
    },
  );

  // -- h: offboard both tiers (P-2) -------------------------------------------
  test('h: DeleteTenant S and P → 204; P’s pool and both keys are gone; S2 stays for the drain', async () => {
    for (const key of ['S', 'P'] as const) {
      const del = await platform.call('DELETE', `platform/tenants/${tenantIds[key]}`);
      expectStatus(del, 204, `DeleteTenant ${key}`);
    }
    const formerS = tenantIds.S;
    const formerP = tenantIds.P;
    delete tenantIds.S; // afterAll must not try to re-delete
    delete tenantIds.P;

    // The narrowed admin tokens stop working at once (R-9: the row is gone).
    expectStatus(await tenant.call('GET', 'tenant/users', narrowedAdmin.S), 403, 'S admin after delete');
    expectStatus(await tenant.call('GET', 'tenant/users', narrowedAdmin.P), 403, 'P admin after delete');

    // GetTenant → 404 for both.
    expectStatus(await platform.call('GET', `platform/tenants/${formerS}`), 404, 'GetTenant S after delete');
    expectStatus(await platform.call('GET', `platform/tenants/${formerP}`), 404, 'GetTenant P after delete');

    // P's pool is deleted (DeleteTenant owns the pool in pool-per-tenant).
    await expect(cognito.send(new DescribeUserPoolCommand({ UserPoolId: premium.userPoolId }))).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
    });

    // The shared pool keeps only S2's admin from this run: S's users went
    // with S (shared-pool deprovisioning), and nothing of P was ever there.
    const left = await cognito.send(
      new ListUsersCommand({ UserPoolId: stack.userPoolId!, Filter: `email ^= "success+${runId}-"` }),
    );
    expect((left.Users ?? []).map((x) => x.Username).sort()).toEqual([usernames.s2]);

    // ADR-0025: both keys are gone, by id and by name.
    for (const [key, id] of [
      ['S', formerS],
      ['P', formerP],
    ] as const) {
      await expect(apigw.send(new GetApiKeyCommand({ apiKey: apiKeyIds[key] }))).rejects.toMatchObject({
        name: 'NotFoundException',
      });
      expect(await keysNamedFor(id)).toEqual([]);
    }

    // S2 is left behind on purpose, like the one tenant each §10 run leaves
    // (scenario.ts step 11): the stack's TenantDrain must offboard it on
    // `cdk destroy` (ADR-0022), so the drain is proven for a tiered stack
    // too. A leftover user or group after the destroy is the failure signal.
    const s2 = await platform.call<{ tenant: { status: string; tier?: string } }>('GET', `platform/tenants/${tenantIds.S2}`);
    expectStatus(s2, 200, 'GetTenant S2 (left for the drain)');
    expect(s2.body.tenant.status).toBe('ACTIVE');
    expect(s2.body.tenant.tier).toBe('standard');
  });
});
