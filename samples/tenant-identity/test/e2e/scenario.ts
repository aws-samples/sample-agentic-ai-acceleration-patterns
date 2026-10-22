// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The spec §10 acceptance scenario, one `describe` per topology, run
 * unchanged against all three deployed stacks (spec P-1). Steps 2-9 and 11
 * are here; steps 1 (synth input validation) and 10 (the `DELETING` window)
 * are unit-level and covered in `test/main.test.ts` and the trigger tests.
 *
 * The scenario is the client (spec §3.2): it obtains real tokens through the
 * `IssueToken`/`RefreshToken` test-aid routes (ADR-0006), narrows them
 * through `POST /oauth2/token` (ADR-0009), verifies every token it asserts
 * on (spec §3.2), and drives the tenant admin door (ADR-0014). It never
 * prints a token, refresh token, or password (spec N-4/N-6/N-7); failed
 * assertions surface claim names and tenant ids only.
 *
 * Coverage (spec §10 step 11): every platform operation, every tenant
 * operation, and the exchange are recorded as they run and asserted present
 * at the end of each topology.
 */

import {
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  DeleteGroupCommand,
  AdminAddUserToGroupCommand,
  DescribeUserPoolCommand,
  GetTokensFromRefreshTokenCommand,
  GetUserCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ulid } from 'ulid';
import {
  AccessTokenVerifier,
  Claims,
  decodeClaims,
  discoverStack,
  ExchangeClient,
  PlatformClient,
  region,
  StackOutputs,
  TenantClient,
} from './clients';
import {
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_API_READ,
  SCOPE_TENANT_ADMIN,
  TENANT_ATTRIBUTE,
  tenantResource,
  TENANT_POOL_NAME_PREFIX,
  TOKEN_TYPE_ACCESS,
  Topology,
} from '../../src/shared/constants';

// ---------------------------------------------------------------------------
// Which topologies to run (spec: E2E_TOPOLOGIES default all three)
// ---------------------------------------------------------------------------

export function topologyEnabled(topology: Topology): boolean {
  const raw = process.env.E2E_TOPOLOGIES;
  if (raw === undefined || raw.trim() === '') {
    return true;
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .includes(topology);
}

// ---------------------------------------------------------------------------
// Coverage ledger (spec §10 step 11)
// ---------------------------------------------------------------------------

/** Every operation of model/platform.smithy. */
const PLATFORM_OPS = [
  'CreateTenant',
  'GetTenant',
  'ListTenants',
  'DeleteTenant',
  'CreateUser',
  'GetUser',
  'ListUsers',
  'UpdateUser',
  'DeleteUser',
  'CreateMembership',
  'DeleteMembership',
  'IssueToken',
  'RefreshToken',
] as const;

/** Every operation of model/tenant.smithy, plus the exchange. */
const TENANT_OPS = [
  'CreateTenantUser',
  'GetTenantUser',
  'ListTenantUsers',
  'UpdateTenantUser',
  'DeleteTenantUser',
] as const;
const EXCHANGE_OP = 'ExchangeToken';

type Op =
  | (typeof PLATFORM_OPS)[number]
  | (typeof TENANT_OPS)[number]
  | typeof EXCHANGE_OP;

class Coverage {
  private readonly seen = new Set<Op>();
  record(op: Op): void {
    this.seen.add(op);
  }
  /** Platform + tenant ops expected in THIS topology (some are 1,2-only etc). */
  missing(topology: Topology): Op[] {
    const required: Op[] = [...PLATFORM_OPS, ...TENANT_OPS, EXCHANGE_OP];
    // CreateMembership/DeleteMembership only have meaning in topology 3,
    // but the scenario still *calls* them in every topology (they answer
    // UnsupportedInTopology in 1 and 2, spec §10 step 3), so they count as
    // exercised everywhere.
    void topology;
    return required.filter((op) => !this.seen.has(op));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Tokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

/** A fresh run id so names and e-mails never collide across runs. */
function newRunId(): string {
  return ulid().slice(-10).toLowerCase();
}

function emailFor(runId: string, who: string): string {
  // SES simulator addresses: no mail is sent, and the provisioners suppress
  // messages anyway (steering SES_SIMULATOR_EMAILS, spec §10).
  return `success+${runId}-${who}@simulator.amazonses.com`;
}

interface AssertNumber {
  status: number;
  body?: unknown;
}

function expectStatus(result: AssertNumber, want: number, ctx: string): void {
  if (result.status !== want) {
    // Print only error bodies: a 2xx body may hold tokens.
    const body = result.status >= 400 && result.body !== undefined ? ` ${JSON.stringify(result.body).slice(0, 300)}` : '';
    throw new Error(`${ctx}: expected HTTP ${want}, got ${result.status}${body}`);
  }
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

export function defineScenario(topology: Topology): void {
  const run = topologyEnabled(topology) ? describe : describe.skip;

  run(`§10 scenario — ${topology}`, () => {
    jest.setTimeout(900_000);

    const coverage = new Coverage();
    const runId = newRunId();

    let stack: StackOutputs;
    let platform: PlatformClient;
    let exchange: ExchangeClient;
    let tenant: TenantClient;
    let cognito: CognitoIdentityProviderClient;

    // Shared-pool* verifier is built once from published parameters;
    // pool-per-tenant verifiers are per-tenant, built from GetTenant.issuer.
    let sharedVerifier: AccessTokenVerifier | undefined;

    // State threaded through the sequential steps.
    const tenantIds: Record<string, string> = {}; // A, B
    const tenantIssuers: Record<string, string> = {}; // topology 1
    const clientIds: Record<string, string> = {}; // exchange client_id per tenant
    const usernames: Record<string, string> = {}; // a1, b1, u1, u2
    const tokens: Record<string, Tokens> = {}; // a1, u1, u2
    let u1PreDeleteAccessToken: string;
    let u1Verifier: AccessTokenVerifier | undefined; // topology 1: u1's pool (A)
    let narrowedAdminTokenA: string; // step 8, re-checked at step 9
    let formerAId: string; // tenant A's ULID, kept after it is deleted

    /** Exchange client_id for a tenant: shared (2,3) or the tenant's own (1). */
    function exchangeClientId(tenantKey: string): string {
      return topology === 'pool-per-tenant' ? clientIds[tenantKey] : stack.appClientId!;
    }

    /** A verifier for a tenant's tokens (topology-aware). */
    function verifierFor(tenantKey: string): AccessTokenVerifier {
      if (topology === 'pool-per-tenant') {
        return AccessTokenVerifier.forIssuer(tenantIssuers[tenantKey], clientIds[tenantKey]);
      }
      return sharedVerifier!;
    }

    async function issueToken(tenantKey: string, who: string): Promise<Tokens> {
      const res = await platform.call<{
        accessToken: string;
        idToken: string;
        refreshToken: string;
      }>(
        'POST',
        `platform/tenants/${tenantIds[tenantKey]}/users/${usernames[who]}/token`,
        { password: 'Synthetic-Pass-1!' },
      );
      coverage.record('IssueToken');
      expectStatus(res, 200, `IssueToken ${who}`);
      return {
        accessToken: res.body.accessToken,
        idToken: res.body.idToken,
        refreshToken: res.body.refreshToken,
      };
    }

    async function createUser(
      tenantKey: string,
      email: string,
      admin = false,
    ): Promise<string> {
      const res = await platform.call<{ user: { username: string } }>(
        'POST',
        `platform/tenants/${tenantIds[tenantKey]}/users`,
        { email, admin },
      );
      coverage.record('CreateUser');
      expectStatus(res, 201, `CreateUser ${email}`);
      return res.body.user.username;
    }

    // -- setup --------------------------------------------------------------
    beforeAll(async () => {
      stack = await discoverStack(topology);
      platform = new PlatformClient(stack.apiUrl);
      exchange = new ExchangeClient(stack.apiUrl);
      tenant = new TenantClient(stack.apiUrl);
      cognito = new CognitoIdentityProviderClient({ region: region() });
      if (topology !== 'pool-per-tenant') {
        sharedVerifier = AccessTokenVerifier.forPool(stack.userPoolId!, stack.appClientId!);
      }
    });

    // Best-effort cleanup: delete any tenant this run created so a failed
    // run leaves nothing behind (spec P-4, §10 step 11).
    afterAll(async () => {
      for (const key of Object.keys(tenantIds)) {
        try {
          await platform.call('DELETE', `platform/tenants/${tenantIds[key]}`);
        } catch {
          // best effort
        }
      }
    });

    // -- R-6, §6.3: discovery parameters ------------------------------------
    // One stack per account and Region publishes them (ADR-0017). When this
    // stack is the publisher, every parameter must name this stack.
    test('R-6: the shared discovery parameters name the publishing stack', async () => {
      const ssm = new SSMClient({ region: process.env.AWS_REGION });
      const read = async (name: string) =>
        (await ssm.send(new GetParameterCommand({ Name: `/application-plane/shared/identity/${name}` })))
          .Parameter?.Value;
      const published = await read('topology');
      expect(published).toBeDefined();
      if (published !== topology) {
        return; // another stack in this account publishes
      }
      expect(await read('apiUrl')).toBe(stack.apiUrl);
      if (topology !== 'pool-per-tenant') {
        expect(await read('userPoolId')).toBe(stack.userPoolId);
        expect(await read('appClientId')).toBe(stack.appClientId);
      }
    });

    // -- step 2: onboard ----------------------------------------------------
    test('step 2: CreateTenant A and B, each ACTIVE with an admin and a temp password', async () => {
      for (const [key, who] of [
        ['A', 'a1'],
        ['B', 'b1'],
      ] as const) {
        const res = await platform.call<{
          tenant: {
            tenantId: string;
            status: string;
            userPoolId?: string;
            appClientId?: string;
            issuer?: string;
            groupName?: string;
          };
          admin: { user: { username: string }; temporaryPassword?: string };
        }>('POST', 'platform/tenants', {
          name: `${runId}-${key}`,
          adminEmail: emailFor(runId, who),
        });
        coverage.record('CreateTenant');
        expectStatus(res, 201, `CreateTenant ${key}`);
        expect(res.body.tenant.status).toBe('ACTIVE');
        expect(res.body.admin.user.username).toBeDefined();
        expect(typeof res.body.admin.temporaryPassword).toBe('string');
        tenantIds[key] = res.body.tenant.tenantId;
        usernames[who] = res.body.admin.user.username;

        // GetTenant returns the topology-specific fields (§10 step 2).
        const got = await platform.call<{
          tenant: {
            userPoolId?: string;
            appClientId?: string;
            issuer?: string;
            groupName?: string;
          };
        }>('GET', `platform/tenants/${tenantIds[key]}`);
        coverage.record('GetTenant');
        expectStatus(got, 200, `GetTenant ${key}`);
        if (topology === 'pool-per-tenant') {
          expect(got.body.tenant.userPoolId).toBeDefined();
          expect(got.body.tenant.appClientId).toBeDefined();
          expect(got.body.tenant.issuer).toBeDefined();
          tenantIssuers[key] = got.body.tenant.issuer!;
          clientIds[key] = got.body.tenant.appClientId!;
        } else if (topology === 'shared-pool-multi-tenant') {
          expect(got.body.tenant.groupName).toBe(`t-${tenantIds[key]}`);
          expect(got.body.tenant.userPoolId).toBeUndefined();
        } else {
          expect(got.body.tenant.userPoolId).toBeUndefined();
          expect(got.body.tenant.groupName).toBeUndefined();
        }
      }

      // ListTenants includes A and B (coverage + registry scan).
      const list = await platform.call<{ tenants: { tenantId: string }[] }>(
        'GET',
        'platform/tenants',
      );
      coverage.record('ListTenants');
      expectStatus(list, 200, 'ListTenants');
      const ids = new Set(list.body.tenants.map((t) => t.tenantId));
      expect(ids.has(tenantIds.A)).toBe(true);
      expect(ids.has(tenantIds.B)).toBe(true);

      // Topology 1: two pools exist, each with the trigger attached.
      if (topology === 'pool-per-tenant') {
        for (const key of ['A', 'B'] as const) {
          const pool = tenantIssuers[key].split('/').pop()!;
          const describe_ = await cognito.send(
            new DescribeUserPoolCommand({ UserPoolId: pool }),
          );
          expect(describe_.UserPool?.Name?.startsWith(TENANT_POOL_NAME_PREFIX)).toBe(true);
          expect(
            describe_.UserPool?.LambdaConfig?.PreTokenGenerationConfig?.LambdaArn ??
              describe_.UserPool?.LambdaConfig?.PreTokenGeneration,
          ).toBeDefined();
        }
      }
    });

    // -- step 3: users, topology-specific 409/400, R-12 404s ----------------
    test('step 3: CreateUser u1/u2; topology-specific conflicts; R-12 isolation', async () => {
      usernames.u1 = await createUser('A', emailFor(runId, 'u1'));
      usernames.u2 = await createUser('B', emailFor(runId, 'u2'));

      if (topology === 'shared-pool') {
        // u1's e-mail in B → 409 (one person, one tenant in a shared pool).
        const dup = await platform.call('POST', `platform/tenants/${tenantIds.B}/users`, {
          email: emailFor(runId, 'u1'),
        });
        coverage.record('CreateUser');
        expectStatus(dup, 409, 'CreateUser u1 e-mail in B');
      }

      if (topology === 'shared-pool-multi-tenant') {
        // CreateMembership u1 → B succeeds.
        const add = await platform.call(
          'PUT',
          `platform/tenants/${tenantIds.B}/users/${usernames.u1}/membership`,
        );
        coverage.record('CreateMembership');
        expectStatus(add, 204, 'CreateMembership u1→B');
      } else {
        // Topologies 1 and 2: CreateMembership → 400 UnsupportedInTopology.
        const add = await platform.call<{ reason?: string }>(
          'PUT',
          `platform/tenants/${tenantIds.A}/users/${usernames.u1}/membership`,
        );
        coverage.record('CreateMembership');
        expectStatus(add, 400, 'CreateMembership unsupported');
        expect(add.body.reason).toBe('UnsupportedInTopology');
        const remove = await platform.call<{ reason?: string }>(
          'DELETE',
          `platform/tenants/${tenantIds.A}/users/${usernames.u1}/membership`,
        );
        coverage.record('DeleteMembership');
        expectStatus(remove, 400, 'DeleteMembership unsupported');
        expect(remove.body.reason).toBe('UnsupportedInTopology');
      }

      // R-12 (every topology): DeleteUser and IssueToken for A with u2's
      // username → 404, and u2 still exists and still signs in.
      const delCross = await platform.call(
        'DELETE',
        `platform/tenants/${tenantIds.A}/users/${usernames.u2}`,
      );
      coverage.record('DeleteUser');
      expectStatus(delCross, 404, 'DeleteUser A/u2 (R-12)');

      const tokCross = await platform.call(
        'POST',
        `platform/tenants/${tenantIds.A}/users/${usernames.u2}/token`,
        { password: 'Synthetic-Pass-1!' },
      );
      coverage.record('IssueToken');
      expectStatus(tokCross, 404, 'IssueToken A/u2 (R-12)');

      const u2Still = await platform.call(
        'GET',
        `platform/tenants/${tenantIds.B}/users/${usernames.u2}`,
      );
      coverage.record('GetUser');
      expectStatus(u2Still, 200, 'GetUser B/u2 after R-12');
      tokens.u2 = await issueToken('B', 'u2'); // still signs in

      // Vendor user management (§5.1): ListUsers shows A's users only, and
      // UpdateUser flips the admin flag through the platform door.
      const listA = await platform.call<{ users: { username: string }[] }>(
        'GET',
        `platform/tenants/${tenantIds.A}/users`,
      );
      coverage.record('ListUsers');
      expectStatus(listA, 200, 'ListUsers A');
      const listed = listA.body.users.map((u) => u.username);
      expect(listed).toContain(usernames.u1);
      expect(listed).not.toContain(usernames.u2);

      for (const admin of [true, false]) {
        const upd = await platform.call<{ user: { admin: boolean } }>(
          'PATCH',
          `platform/tenants/${tenantIds.A}/users/${usernames.u1}`,
          { admin },
        );
        coverage.record('UpdateUser');
        expectStatus(upd, 200, `UpdateUser A/u1 admin=${admin}`);
        expect(upd.body.user.admin).toBe(admin);
      }
      const updCross = await platform.call(
        'PATCH',
        `platform/tenants/${tenantIds.A}/users/${usernames.u2}`,
        { admin: true },
      );
      expectStatus(updCross, 404, 'UpdateUser A/u2 (R-12)');
    });

    // -- step 4: token contract (P-6) --------------------------------------
    test('step 4: token contract — tenant claim per topology, ID token has none', async () => {
      tokens.u1 = await issueToken('A', 'u1');

      const u1Claims = await verifierFor('A').verify(tokens.u1.accessToken);
      expect(u1Claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      const u2Claims = await verifierFor('B').verify(tokens.u2.accessToken);
      expect(u2Claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020

      if (topology === 'shared-pool-multi-tenant') {
        expect(u1Claims.tenants).toEqual(expect.arrayContaining([tenantIds.A, tenantIds.B]));
        expect((u1Claims.tenants as string[]).length).toBe(2);
        expect(u2Claims.tenants).toEqual([tenantIds.B]);
        expect(u1Claims.tenant_id).toBeUndefined();
      } else {
        expect(u1Claims.tenant_id).toBe(tenantIds.A);
        expect(u2Claims.tenant_id).toBe(tenantIds.B);
        if (topology === 'pool-per-tenant') {
          // iss equals the tenant's issuer from GetTenant.
          expect(u1Claims.iss).toBe(tenantIssuers.A);
        }
      }
      expect(typeof u1Claims.sub).toBe('string');

      // ID tokens carry no tenant claim.
      const u1IdClaims = decodeClaims(tokens.u1.idToken);
      expect(u1IdClaims.tenant_id).toBeUndefined();
      expect(u1IdClaims.tenants).toBeUndefined();
    });

    // -- step 5: claim integrity (P-3) -------------------------------------
    test('step 5: claim integrity — the tenant claim cannot be chosen by the caller', async () => {
      // Every topology: a user cannot change their own e-mail with their
      // un-narrowed access token (T-27, R-17). E-mail is immutable at the
      // pool, so an invitation address can never be squatted.
      await expect(
        cognito.send(
          new UpdateUserAttributesCommand({
            AccessToken: tokens.u1.accessToken,
            UserAttributes: [{ Name: 'email', Value: emailFor(runId, 'squat') }],
          }),
        ),
      ).rejects.toBeDefined();
      const unchanged = await platform.call<{ user: { email: string } }>(
        'GET',
        `platform/tenants/${tenantIds.A}/users/${usernames.u1}`,
      );
      coverage.record('GetUser');
      expectStatus(unchanged, 200, 'GetUser u1 after refused e-mail write');
      expect(unchanged.body.user.email).toBe(emailFor(runId, 'u1'));

      if (topology === 'shared-pool') {
        // u1 cannot change custom:tenantId with its own access token.
        await expect(
          cognito.send(
            new UpdateUserAttributesCommand({
              AccessToken: tokens.u1.accessToken,
              UserAttributes: [{ Name: TENANT_ATTRIBUTE, Value: tenantIds.B }],
            }),
          ),
        ).rejects.toBeDefined();
        // A fresh token still says A.
        const fresh = await issueToken('A', 'u1');
        const claims = await verifierFor('A').verify(fresh.accessToken);
        expect(claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
        expect(claims.tenant_id).toBe(tenantIds.A);
      } else if (topology === 'shared-pool-multi-tenant') {
        // The vendor creates a non-t-/non-admin- group, adds u1, re-issues:
        // `tenants` is unchanged (only `t-` groups contribute, §7.3).
        // Per-run name, deleted afterwards, so runs never collide and the
        // pool is left as it was (§10 step 11).
        const roleGroup = `role-admin-${runId}`;
        await cognito.send(
          new CreateGroupCommand({ UserPoolId: stack.userPoolId!, GroupName: roleGroup }),
        );
        try {
          await cognito.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: stack.userPoolId!,
              Username: usernames.u1,
              GroupName: roleGroup,
            }),
          );
          const fresh = await issueToken('A', 'u1');
          const claims = await verifierFor('A').verify(fresh.accessToken);
          expect(claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
          expect(claims.tenants).toEqual(
            expect.arrayContaining([tenantIds.A, tenantIds.B]),
          );
          expect((claims.tenants as string[]).length).toBe(2);
        } finally {
          await cognito.send(
            new DeleteGroupCommand({ UserPoolId: stack.userPoolId!, GroupName: roleGroup }),
          );
        }
      } else {
        // pool-per-tenant: a user created directly in pool B (bypassing the
        // platform API) still receives tenant_id = B — the claim comes from
        // the pool, not the caller.
        const poolB = tenantIssuers.B.split('/').pop()!;
        const bypassEmail = emailFor(runId, 'bypass');
        await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: poolB,
            Username: bypassEmail,
            MessageAction: 'SUPPRESS',
            UserAttributes: [{ Name: 'email', Value: bypassEmail }],
          }),
        );
        await cognito.send(
          new AdminSetUserPasswordCommand({
            UserPoolId: poolB,
            Username: bypassEmail,
            Password: 'Synthetic-Pass-1!',
            Permanent: true,
          }),
        );
        const auth = await cognito.send(
          new AdminInitiateAuthCommand({
            UserPoolId: poolB,
            ClientId: clientIds.B,
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: bypassEmail, PASSWORD: 'Synthetic-Pass-1!' },
          }),
        );
        const access = auth.AuthenticationResult?.AccessToken;
        expect(access).toBeDefined();
        const claims = await verifierFor('B').verify(access!);
        expect(claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
        expect(claims.tenant_id).toBe(tenantIds.B);
      }
    });

    // -- step 6: refresh re-runs the trigger (topology 3) -------------------
    test('step 6: refresh re-runs the trigger (shared-pool-multi-tenant)', async () => {
      if (topology !== 'shared-pool-multi-tenant') {
        // Still exercise RefreshToken for coverage in topologies 1 and 2.
        const r = await platform.call(
          'POST',
          `platform/tenants/${tenantIds.A}/users/${usernames.u1}/token/refresh`,
          { refreshToken: tokens.u1.refreshToken },
        );
        coverage.record('RefreshToken');
        expectStatus(r, 200, 'RefreshToken (coverage, topo 1/2)');
        return;
      }

      // DeleteMembership u1 from B; refresh → tenants = [A].
      const delB = await platform.call(
        'DELETE',
        `platform/tenants/${tenantIds.B}/users/${usernames.u1}/membership`,
      );
      coverage.record('DeleteMembership');
      expectStatus(delB, 204, 'DeleteMembership u1 from B');

      const r1 = await platform.call<{ accessToken: string }>(
        'POST',
        `platform/tenants/${tenantIds.A}/users/${usernames.u1}/token/refresh`,
        { refreshToken: tokens.u1.refreshToken },
      );
      coverage.record('RefreshToken');
      expectStatus(r1, 200, 'RefreshToken u1 after remove B');
      const c1 = await verifierFor('A').verify(r1.body.accessToken);
      expect(c1['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      expect(c1.tenants).toEqual([tenantIds.A]);

      // DeleteMembership u1 from A → 409 (last tenant).
      const delA = await platform.call(
        'DELETE',
        `platform/tenants/${tenantIds.A}/users/${usernames.u1}/membership`,
      );
      coverage.record('DeleteMembership');
      expectStatus(delA, 409, 'DeleteMembership u1 last tenant');

      // CreateMembership u1 → B again; refresh → tenants = [A, B].
      const addB = await platform.call(
        'PUT',
        `platform/tenants/${tenantIds.B}/users/${usernames.u1}/membership`,
      );
      coverage.record('CreateMembership');
      expectStatus(addB, 204, 'CreateMembership u1→B again');

      const r2 = await platform.call<{ accessToken: string; refreshToken?: string }>(
        'POST',
        `platform/tenants/${tenantIds.A}/users/${usernames.u1}/token/refresh`,
        { refreshToken: tokens.u1.refreshToken },
      );
      coverage.record('RefreshToken');
      expectStatus(r2, 200, 'RefreshToken u1 after re-add B');
      const c2 = await verifierFor('A').verify(r2.body.accessToken);
      expect(c2['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      expect(c2.tenants).toEqual(expect.arrayContaining([tenantIds.A, tenantIds.B]));
      expect((c2.tenants as string[]).length).toBe(2);
    });

    // -- step 7: narrowing (P-10), all topologies --------------------------
    test('step 7: narrowing — one tenant, subset scopes, refusals, direct bypass', async () => {
      const resourceA =
        topology === 'shared-pool-multi-tenant' ? tenantResource(tenantIds.A) : undefined;

      const ok = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.u1.refreshToken,
        scope: SCOPE_API_READ,
        resource: resourceA,
      });
      coverage.record('ExchangeToken');
      expectStatus(ok, 200, 'exchange u1 read@A');
      const narrowed = (ok.body as { access_token: string; scope: string }).access_token;
      const nClaims = await verifierFor('A').verify(narrowed);
      expect(nClaims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      expect(nClaims.tenant_id).toBe(tenantIds.A);
      expect(nClaims.tenants).toBeUndefined();
      expect(String(nClaims.scope).split(' ').sort()).toEqual([SCOPE_API_READ]);
      expect(String(nClaims.scope)).not.toContain(COGNITO_USER_ADMIN_SCOPE);
      expect(nClaims.iss).toBe((await verifierFor('A').verify(tokens.u1.accessToken)).iss);

      // Topology 2: the narrowed token's GetUser call is rejected by Cognito
      // (aws.cognito.signin.user.admin was suppressed).
      if (topology === 'shared-pool') {
        await expect(
          cognito.send(new GetUserCommand({ AccessToken: narrowed })),
        ).rejects.toBeDefined();
      }

      // Refusals.
      const targetMismatch = await exchange.exchange({
        clientId: exchangeClientId('B'),
        subjectToken: tokens.u2.refreshToken,
        scope: SCOPE_API_READ,
        resource: tenantResource(tenantIds.A), // u2 holds only B
      });
      coverage.record('ExchangeToken');
      expectStatus(targetMismatch, 400, 'exchange u2 resource=A');
      expect(targetMismatch.oauthError).toBe('invalid_target');

      const badScope = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.u1.refreshToken,
        scope: 'tenant-api/admin',
        resource: resourceA,
      });
      expect(badScope.oauthError).toBe('invalid_scope');

      if (topology === 'shared-pool-multi-tenant') {
        const noResource = await exchange.exchange({
          clientId: exchangeClientId('A'),
          subjectToken: tokens.u1.refreshToken,
          scope: SCOPE_API_READ,
        });
        expect(noResource.oauthError).toBe('invalid_target');
      }

      const wrongSubjectType = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.u1.refreshToken,
        subjectTokenType: TOKEN_TYPE_ACCESS,
        scope: SCOPE_API_READ,
        resource: resourceA,
      });
      expect(wrongSubjectType.oauthError).toBe('invalid_request');

      // Bypass the endpoint: call GetTokensFromRefreshToken directly with
      // u2's refresh token and the §8.2 keys naming A. Cognito fails the
      // request, proving the trigger enforces the rule, not the endpoint.
      await expect(
        cognito.send(
          new GetTokensFromRefreshTokenCommand({
            ClientId: exchangeClientId('B'),
            RefreshToken: tokens.u2.refreshToken,
            ClientMetadata: {
              [NARROW_TENANT_KEY]: tenantIds.A,
              [NARROW_SCOPE_KEY]: SCOPE_API_READ,
            },
          }),
        ),
      ).rejects.toBeDefined();

      // A plain RefreshToken afterwards returns u1's un-narrowed token again
      // (the exchange did not change the session).
      const plain = await platform.call<{ accessToken: string }>(
        'POST',
        `platform/tenants/${tenantIds.A}/users/${usernames.u1}/token/refresh`,
        { refreshToken: tokens.u1.refreshToken },
      );
      coverage.record('RefreshToken');
      expectStatus(plain, 200, 'plain refresh after exchange');
      const pClaims = await verifierFor('A').verify(plain.body.accessToken);
      expect(pClaims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      if (topology === 'shared-pool-multi-tenant') {
        expect((pClaims.tenants as string[]).length).toBe(2);
      } else {
        expect(pClaims.tenant_id).toBe(tenantIds.A);
      }
    });

    // -- step 8: tenant admin (P-11), all topologies ------------------------
    test('step 8: tenant admin — the narrowed admin token manages only tenant A', async () => {
      tokens.a1 = await issueToken('A', 'a1');

      const adminExchange = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.a1.refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource:
          topology === 'shared-pool-multi-tenant' ? tenantResource(tenantIds.A) : tenantResource(tenantIds.A),
      });
      coverage.record('ExchangeToken');
      expectStatus(adminExchange, 200, 'exchange a1 admin@A');
      narrowedAdminTokenA = (adminExchange.body as { access_token: string }).access_token;
      const adminClaims = await verifierFor('A').verify(narrowedAdminTokenA);
      expect(adminClaims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
      expect(adminClaims.tenant_id).toBe(tenantIds.A);
      expect(String(adminClaims.scope).split(' ')).toContain(SCOPE_TENANT_ADMIN);

      // CreateTenantUser u3 → 201.
      const createU3 = await tenant.call<{ user: { username: string; admin: boolean } }>(
        'POST',
        'tenant/users',
        narrowedAdminTokenA,
        { email: emailFor(runId, 'u3') },
      );
      coverage.record('CreateTenantUser');
      expectStatus(createU3, 201, 'CreateTenantUser u3');
      usernames.u3 = createU3.body.user.username;

      // GetTenantUser u3 → admin=false.
      const getU3 = await tenant.call<{ user: { admin: boolean } }>(
        'GET',
        `tenant/users/${usernames.u3}`,
        narrowedAdminTokenA,
      );
      coverage.record('GetTenantUser');
      expectStatus(getU3, 200, 'GetTenantUser u3');
      expect(getU3.body.user.admin).toBe(false);

      // ListTenantUsers → a1, u1, u3, and neither u2 nor b1.
      const list = await tenant.call<{ users: { username: string }[] }>(
        'GET',
        'tenant/users',
        narrowedAdminTokenA,
      );
      coverage.record('ListTenantUsers');
      expectStatus(list, 200, 'ListTenantUsers A');
      const listed = new Set(list.body.users.map((u) => u.username));
      expect(listed.has(usernames.a1)).toBe(true);
      expect(listed.has(usernames.u1)).toBe(true);
      expect(listed.has(usernames.u3)).toBe(true);
      expect(listed.has(usernames.u2)).toBe(false);
      expect(listed.has(usernames.b1)).toBe(false);

      // UpdateTenantUser u3 admin=true then admin=false.
      const promote = await tenant.call(
        'PATCH',
        `tenant/users/${usernames.u3}`,
        narrowedAdminTokenA,
        { admin: true },
      );
      coverage.record('UpdateTenantUser');
      expectStatus(promote, 200, 'UpdateTenantUser u3 admin=true');
      const demote = await tenant.call(
        'PATCH',
        `tenant/users/${usernames.u3}`,
        narrowedAdminTokenA,
        { admin: false },
      );
      coverage.record('UpdateTenantUser');
      expectStatus(demote, 200, 'UpdateTenantUser u3 admin=false');

      // DeleteTenantUser u3 → 204, then platform GetUser u3 → 404.
      const delU3 = await tenant.call(
        'DELETE',
        `tenant/users/${usernames.u3}`,
        narrowedAdminTokenA,
      );
      coverage.record('DeleteTenantUser');
      expectStatus(delU3, 204, 'DeleteTenantUser u3');
      const goneU3 = await platform.call(
        'GET',
        `platform/tenants/${tenantIds.A}/users/${usernames.u3}`,
      );
      coverage.record('GetUser');
      expectStatus(goneU3, 404, 'platform GetUser u3 after delete');

      // Refusals.
      // a1's un-narrowed access token → 403.
      const unNarrowed = await tenant.call(
        'GET',
        'tenant/users',
        tokens.a1.accessToken,
      );
      expectStatus(unNarrowed, 403, 'un-narrowed admin token → 403');

      // a narrowed token with only tenant-api/read → 403.
      const readOnlyExchange = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.a1.refreshToken,
        scope: SCOPE_API_READ,
        resource:
          topology === 'shared-pool-multi-tenant' ? tenantResource(tenantIds.A) : undefined,
      });
      expectStatus(readOnlyExchange, 200, 'exchange a1 read@A');
      const readOnly = (readOnlyExchange.body as { access_token: string }).access_token;
      const readOnlyCall = await tenant.call('GET', 'tenant/users', readOnly);
      expectStatus(readOnlyCall, 403, 'read-only token on /tenant → 403');

      // u1 asks the exchange for tenant-admin/users on A → invalid_scope.
      const u1Admin = await exchange.exchange({
        clientId: exchangeClientId('A'),
        subjectToken: tokens.u1.refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource:
          topology === 'shared-pool-multi-tenant' ? tenantResource(tenantIds.A) : undefined,
      });
      expect(u1Admin.oauthError).toBe('invalid_scope');

      // Topology 3: a1 added to B (member, not admin) asks for admin on B
      // → invalid_scope.
      if (topology === 'shared-pool-multi-tenant') {
        const addA1B = await platform.call(
          'PUT',
          `platform/tenants/${tenantIds.B}/users/${usernames.a1}/membership`,
        );
        coverage.record('CreateMembership');
        expectStatus(addA1B, 204, 'CreateMembership a1→B');
        // a1 needs a token that now carries B; refresh first.
        const a1Refresh = await platform.call<{ accessToken: string }>(
          'POST',
          `platform/tenants/${tenantIds.A}/users/${usernames.a1}/token/refresh`,
          { refreshToken: tokens.a1.refreshToken },
        );
        coverage.record('RefreshToken');
        expectStatus(a1Refresh, 200, 'a1 refresh after join B');
        const a1AdminB = await exchange.exchange({
          clientId: exchangeClientId('B'),
          subjectToken: tokens.a1.refreshToken,
          scope: SCOPE_TENANT_ADMIN,
          resource: tenantResource(tenantIds.B),
        });
        expect(a1AdminB.oauthError).toBe('invalid_scope');
      }

      // GetTenantUser and DeleteTenantUser for u2 (tenant B) → 404 (R-12),
      // u2 still exists.
      const getU2 = await tenant.call(
        'GET',
        `tenant/users/${usernames.u2}`,
        narrowedAdminTokenA,
      );
      coverage.record('GetTenantUser');
      expectStatus(getU2, 404, 'GetTenantUser u2 via A admin (R-12)');
      const delU2 = await tenant.call(
        'DELETE',
        `tenant/users/${usernames.u2}`,
        narrowedAdminTokenA,
      );
      coverage.record('DeleteTenantUser');
      expectStatus(delU2, 404, 'DeleteTenantUser u2 via A admin (R-12)');
      const u2Alive = await platform.call(
        'GET',
        `platform/tenants/${tenantIds.B}/users/${usernames.u2}`,
      );
      coverage.record('GetUser');
      expectStatus(u2Alive, 200, 'u2 still exists after R-12');

      // DeleteTenantUser a1, UpdateTenantUser a1 admin=false → 409 (R-13).
      const selfDelete = await tenant.call(
        'DELETE',
        `tenant/users/${usernames.a1}`,
        narrowedAdminTokenA,
      );
      coverage.record('DeleteTenantUser');
      expectStatus(selfDelete, 409, 'self-delete a1 (R-13)');
      const selfDemote = await tenant.call(
        'PATCH',
        `tenant/users/${usernames.a1}`,
        narrowedAdminTokenA,
        { admin: false },
      );
      coverage.record('UpdateTenantUser');
      expectStatus(selfDemote, 409, 'self-demote a1 (R-13)');

      // Same two calls with a1's e-mail in the path → still 409. The service
      // resolves the e-mail to Cognito's canonical username before the check.
      const a1Email = encodeURIComponent(emailFor(runId, 'a1'));
      const selfDeleteByEmail = await tenant.call('DELETE', `tenant/users/${a1Email}`, narrowedAdminTokenA);
      expectStatus(selfDeleteByEmail, 409, 'self-delete a1 by e-mail (R-13)');
      const selfDemoteByEmail = await tenant.call('PATCH', `tenant/users/${a1Email}`, narrowedAdminTokenA, { admin: false });
      expectStatus(selfDemoteByEmail, 409, 'self-demote a1 by e-mail (R-13)');

      // Self-promote is refused too: no self-update at all (R-13, T-26).
      const selfPromote = await tenant.call('PATCH', `tenant/users/${usernames.a1}`, narrowedAdminTokenA, { admin: true });
      expectStatus(selfPromote, 409, 'self-promote a1 (R-13)');

      // T-26: the vendor demotes a1 while its narrowed admin token is still
      // valid. Every mutation re-checks the admin group and answers 409; a
      // read still works (the accepted residual). Then the vendor restores a1.
      const demoteA1 = await platform.call('PATCH', `platform/tenants/${tenantIds.A}/users/${usernames.a1}`, { admin: false });
      coverage.record('UpdateUser');
      expectStatus(demoteA1, 200, 'platform demotes a1');
      const staleCreate = await tenant.call('POST', 'tenant/users', narrowedAdminTokenA, { email: emailFor(runId, 'u4') });
      expectStatus(staleCreate, 409, 'stale admin token: CreateTenantUser → 409 (T-26)');
      const stalePromote = await tenant.call('PATCH', `tenant/users/${usernames.u1}`, narrowedAdminTokenA, { admin: true });
      expectStatus(stalePromote, 409, 'stale admin token: UpdateTenantUser → 409 (T-26)');
      const staleDelete = await tenant.call('DELETE', `tenant/users/${usernames.u1}`, narrowedAdminTokenA);
      expectStatus(staleDelete, 409, 'stale admin token: DeleteTenantUser → 409 (T-26)');
      const staleRead = await tenant.call('GET', 'tenant/users', narrowedAdminTokenA);
      expectStatus(staleRead, 200, 'stale admin token: ListTenantUsers still reads (T-26 residual)');
      const u1Alive = await platform.call<{ user: { admin: boolean } }>('GET', `platform/tenants/${tenantIds.A}/users/${usernames.u1}`);
      expectStatus(u1Alive, 200, 'u1 untouched by the stale admin');
      expect(u1Alive.body.user.admin).toBe(false);
      const restoreA1 = await platform.call('PATCH', `platform/tenants/${tenantIds.A}/users/${usernames.a1}`, { admin: true });
      expectStatus(restoreA1, 200, 'platform restores a1');

      // Header shape: no header or a non-JWT bearer never reaches the
      // authoriser (API Gateway 401); a well-formed but invalid JWT does (403).
      const noHeader = await tenant.callAnonymous('GET', 'tenant/users');
      expectStatus(noHeader, 401, 'no Authorization header → 401');
      const notAJwt = await tenant.call('GET', 'tenant/users', 'not-a-jwt');
      expectStatus(notAJwt, 401, 'non-JWT bearer → 401');
      const [fHeader, fPayload, fSig] = narrowedAdminTokenA.split('.');
      const forged = `${fHeader}.${fPayload}.${fSig[0] === 'A' ? 'B' : 'A'}${fSig.slice(1)}`;
      const forgedCall = await tenant.call('GET', 'tenant/users', forged);
      expectStatus(forgedCall, 403, 'bad-signature JWT → 403');

      // Topology 3: b1's GetTenantUser for u1 (in A and B) returns a User
      // that does not mention A.
      if (topology === 'shared-pool-multi-tenant') {
        tokens.b1 = await issueToken('B', 'b1');
        const b1Admin = await exchange.exchange({
          clientId: exchangeClientId('B'),
          subjectToken: tokens.b1.refreshToken,
          scope: SCOPE_TENANT_ADMIN,
          resource: tenantResource(tenantIds.B),
        });
        expectStatus(b1Admin, 200, 'exchange b1 admin@B');
        const b1Token = (b1Admin.body as { access_token: string }).access_token;
        const b1GetU1 = await tenant.call<{ user: Record<string, unknown> }>(
          'GET',
          `tenant/users/${usernames.u1}`,
          b1Token,
        );
        coverage.record('GetTenantUser');
        expectStatus(b1GetU1, 200, 'b1 GetTenantUser u1');
        expect(JSON.stringify(b1GetU1.body.user)).not.toContain(tenantIds.A);
      }
    });

    // -- step 9: offboard (P-2) --------------------------------------------
    test('step 9: offboard A — issuance stops, cached verification still works', async () => {
      formerAId = tenantIds.A;

      // Keep a pre-deletion access token and prime the JWKS cache so the
      // token can still be verified after the pool (topology 1) is gone.
      const pre = await issueToken('A', 'u1');
      u1PreDeleteAccessToken = pre.accessToken;
      u1Verifier = verifierFor('A');
      await u1Verifier.primeJwksCache();

      // DeleteTenant A.
      const del = await platform.call('DELETE', `platform/tenants/${tenantIds.A}`);
      coverage.record('DeleteTenant');
      expectStatus(del, 204, 'DeleteTenant A');
      delete tenantIds.A; // afterAll must not try to re-delete A

      // a1's narrowed admin token from step 8 → 403 on ListTenantUsers at
      // once (R-9 reads the registry: A is no longer ACTIVE).
      const adminNow = await tenant.call('GET', 'tenant/users', narrowedAdminTokenA);
      expectStatus(adminNow, 403, 'narrowed admin token after DeleteTenant → 403');

      // Per-topology refresh outcomes for u1.
      if (topology === 'shared-pool-multi-tenant') {
        // Succeeds through B's path, tenants = [B] (u1 still belongs to B).
        const r = await platform.call<{ accessToken: string }>(
          'POST',
          `platform/tenants/${tenantIds.B}/users/${usernames.u1}/token/refresh`,
          { refreshToken: tokens.u1.refreshToken },
        );
        coverage.record('RefreshToken');
        expectStatus(r, 200, 'RefreshToken u1 after A deleted (topo 3)');
        const claims = await verifierFor('B').verify(r.body.accessToken);
        expect(claims['cognito:groups']).toBeUndefined(); // P-6, ADR-0020
        expect(claims.tenants).toEqual([tenantIds.B]);
      } else {
        // Topologies 1 and 2: u1's only tenant is gone, so a refresh fails.
        // Topology 1: the pool is deleted, so GetTokensFromRefreshToken
        // against the former client throws. Topology 2: the user is deleted,
        // so the refresh token is rejected. Drive it directly against
        // Cognito with u1's former exchange client.
        await expect(
          cognito.send(
            new GetTokensFromRefreshTokenCommand({
              ClientId: exchangeClientId('A'),
              RefreshToken: tokens.u1.refreshToken,
            }),
          ),
        ).rejects.toBeDefined();
      }

      // u1's pre-deletion access token still verifies against keys cached
      // before the deletion (the 5-minute bound the README names, N-1).
      const cachedClaims = u1Verifier.verifyCached(u1PreDeleteAccessToken);
      expect(typeof cachedClaims.sub).toBe('string');

      if (topology === 'pool-per-tenant') {
        // Cognito keeps serving a deleted pool's JWKS (ADR-0018), so the
        // signature alone still checks out. The issuer allowlist is what
        // stops trust: A's issuer is no longer in the registry …
        const after = await platform.call<{ tenants: { issuer?: string }[] }>(
          'GET',
          'platform/tenants',
        );
        expectStatus(after, 200, 'ListTenants after DeleteTenant A');
        expect(after.body.tenants.map((t) => t.issuer)).not.toContain(tenantIssuers.A);
        // … and DescribeUserPool → ResourceNotFoundException.
        const poolA = tenantIssuers.A.split('/').pop()!;
        await expect(
          cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolA })),
        ).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
      }

      if (topology === 'shared-pool-multi-tenant') {
        // Exchanging u1's refresh token for A → invalid_target (A is gone),
        // for B → success (u1 still belongs to B).
        const exA = await exchange.exchange({
          clientId: exchangeClientId('B'),
          subjectToken: tokens.u1.refreshToken,
          scope: SCOPE_API_READ,
          resource: tenantResource(formerAId),
        });
        coverage.record('ExchangeToken');
        expect(exA.oauthError).toBe('invalid_target');
        const exB = await exchange.exchange({
          clientId: exchangeClientId('B'),
          subjectToken: tokens.u1.refreshToken,
          scope: SCOPE_API_READ,
          resource: tenantResource(tenantIds.B),
        });
        expectStatus(exB, 200, 'exchange u1 for B after A deleted');

        // Group t-A is gone; u1 and u2 still exist in the pool.
        await expect(
          cognito.send(
            new ListUsersInGroupCommand({
              UserPoolId: stack.userPoolId!,
              GroupName: `t-${formerAId}`,
            }),
          ),
        ).rejects.toBeDefined();
        const stillU1 = await cognito.send(
          new ListUsersCommand({
            UserPoolId: stack.userPoolId!,
            Filter: `username = "${usernames.u1}"`,
          }),
        );
        expect(stillU1.Users ?? []).toHaveLength(1);
      }

      if (topology === 'shared-pool') {
        // u1 (whose only tenant was A) is deleted from the pool.
        const goneU1 = await cognito.send(
          new ListUsersCommand({
            UserPoolId: stack.userPoolId!,
            Filter: `username = "${usernames.u1}"`,
          }),
        );
        expect(goneU1.Users ?? []).toHaveLength(0);
      }

      // GetTenant A → 404.
      const getA = await platform.call('GET', `platform/tenants/${formerAId}`);
      coverage.record('GetTenant');
      expectStatus(getA, 404, 'GetTenant A after delete');
    });

    // -- step 11: teardown + coverage --------------------------------------
    test('step 11: teardown B and assert full operation coverage', async () => {
      const delB = await platform.call('DELETE', `platform/tenants/${tenantIds.B}`);
      coverage.record('DeleteTenant');
      expectStatus(delB, 204, 'DeleteTenant B');
      delete tenantIds.B;

      // After both tenants are gone, nothing attributable to the run should
      // remain. Shared pools: no users with the run's e-mails, and no groups
      // t-/admin- for either tenant. pool-per-tenant: the pools are gone
      // (DeleteTenant deletes the pool; step 9 already proved A's pool is
      // gone via DescribeUserPool).
      if (topology !== 'pool-per-tenant') {
        const users = await cognito.send(
          new ListUsersCommand({
            UserPoolId: stack.userPoolId!,
            Filter: `email ^= "success+${runId}-"`,
          }),
        );
        expect(users.Users ?? []).toHaveLength(0);

        // No group t-/admin- for either tenant remains.
        for (const id of [formerAId, tenantIds.B].filter((v): v is string => v !== undefined)) {
          for (const group of [`t-${id}`, `admin-${id}`]) {
            await expect(
              cognito.send(
                new ListUsersInGroupCommand({ UserPoolId: stack.userPoolId!, GroupName: group }),
              ),
            ).rejects.toBeDefined();
          }
        }
      }

      // Every platform op, every tenant op, and the exchange ran (§10 step 11).
      expect(coverage.missing(topology)).toEqual([]);

      // Leave one tenant behind on purpose. The stack's TenantDrain must
      // offboard it on `cdk destroy` (ADR-0022): a leftover pool, group, or
      // user after the destroy is the failure signal.
      const leftover = await platform.call<{ tenant: { status: string } }>('POST', 'platform/tenants', {
        name: `${runId}-left-for-drain`,
        adminEmail: emailFor(runId, 'drain'),
      });
      expectStatus(leftover, 201, 'CreateTenant left for the stack drain');
      expect(leftover.body.tenant.status).toBe('ACTIVE');
    });
  });
}

