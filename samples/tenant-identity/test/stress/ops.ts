// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The calls the stress scenarios make, each timed and counted in a Recorder,
 * and the isolation assertions they share (P-1: a token for tenant A is never
 * accepted for tenant B). Built on the end-to-end test's clients
 * (`test/e2e/clients.ts`), so the stress slice calls the API the way the
 * scenario and a vendor do. Never logs or returns a password; tokens stay in
 * the memory of the calling scenario.
 */

import { randomBytes } from 'node:crypto';
import type { ManifestUser } from './manifest';
import type { Recorder } from './recorder';
import { SCOPE_TENANT_ADMIN, tenantResource } from '../../src/shared/constants';
import {
  type AccessTokenVerifier,
  type ExchangeClient,
  type HttpResult,
  type PlatformClient,
  type TenantClient,
} from '../e2e/clients';

export interface Ctx {
  readonly platform: PlatformClient;
  readonly exchange: ExchangeClient;
  readonly tenantApi: TenantClient;
  readonly verifier: AccessTokenVerifier;
  readonly clientId: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A password Cognito's default policy accepts, fresh for every run and never written down. */
export function randomPassword(): string {
  return `Aa1!${randomBytes(18).toString('base64url')}`;
}

/** Runs `fn` over `items`, at most `limit` at once. */
export async function runPool<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Spaces callers at least 1/ratePerSecond apart, across every caller of one pacer. */
export class Pacer {
  private nextAt = 0;
  constructor(private readonly ratePerSecond: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + 1000 / this.ratePerSecond;
    if (at > now) {
      await sleep(at - now);
    }
  }
}

// ---------------------------------------------------------------------------
// One timed call
// ---------------------------------------------------------------------------

/** Times a call and records it. A thrown transport error is status 0. */
export async function timed<T>(
  rec: Recorder,
  hop: string,
  tenant: string,
  fn: () => Promise<HttpResult<T>>,
): Promise<HttpResult<T>> {
  const t0 = performance.now();
  try {
    const result = await fn();
    rec.observe(hop, result.status, (performance.now() - t0) / 1000, tenant, result.oauthError);
    return result;
  } catch {
    rec.observe(hop, 0, (performance.now() - t0) / 1000, tenant);
    return { status: 0, body: undefined as T };
  }
}

/** Statuses a caller waits out: stage throttle, dependency throttle (ADR-0037), transport failure. */
export const RETRYABLE = (status: number): boolean => status === 429 || status === 503 || status === 0;

/** The same call again while `again(status)`, with jittered backoff; the last result when attempts run out. */
export async function withRetry<T>(
  call: () => Promise<HttpResult<T>>,
  again: (status: number) => boolean = RETRYABLE,
  attempts = 12,
): Promise<HttpResult<T>> {
  let result = await call();
  for (let attempt = 1; attempt < attempts && again(result.status); attempt += 1) {
    await sleep(Math.min(8000, 400 * 2 ** attempt) * (0.5 + Math.random()));
    result = await call();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Platform operations
// ---------------------------------------------------------------------------

interface UserBody { readonly username: string; readonly email?: string }

async function findUserByEmail(ctx: Ctx, rec: Recorder, tenantId: string, email: string): Promise<string | undefined> {
  let token: string | undefined;
  do {
    const query = token === undefined ? '' : `?nextToken=${encodeURIComponent(token)}`;
    const page = await withRetry(() =>
      timed(rec, 'platform-list-users', tenantId, () =>
        ctx.platform.call<{ users: UserBody[]; nextToken?: string }>('GET', `platform/tenants/${tenantId}/users${query}`)),
    );
    if (page.status !== 200) {
      return undefined;
    }
    const found = page.body.users.find((u) => u.email === email);
    if (found !== undefined) {
      return found.username;
    }
    token = page.body.nextToken;
  } while (token !== undefined);
  return undefined;
}

/**
 * Creates one user of an existing tenant. A 409 means the e-mail is already
 * there (an earlier attempt that timed out): the user is looked up instead.
 */
export async function createUser(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  email: string,
  firstAdmin = false,
): Promise<string | undefined> {
  const body = firstAdmin ? { email, firstAdmin: true } : { email };
  const r = await withRetry(() =>
    timed(rec, 'create-user', tenantId, () =>
      ctx.platform.call<{ user: UserBody }>('POST', `platform/tenants/${tenantId}/users`, body)),
  );
  if (r.status === 201) {
    return r.body.user.username;
  }
  if (r.status === 409) {
    return findUserByEmail(ctx, rec, tenantId, email);
  }
  rec.finding(`CreateUser for tenant ${tenantId}: HTTP ${r.status}`);
  return undefined;
}

/**
 * Creates a tenant with a caller-supplied id and its first admin, following
 * ADR-0037: a 503 may leave the tenant ACTIVE without its admin, so the
 * recovery reads the tenant and claims the first-admin slot, instead of
 * repeating a blind create. Returns the admin's username.
 */
export async function createTenantWithAdmin(
  ctx: Ctx,
  rec: Recorder,
  spec: { readonly tenantId: string; readonly name: string; readonly adminEmail: string },
): Promise<string | undefined> {
  const { tenantId } = spec;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const r = await timed(rec, 'create-tenant', tenantId, () =>
      ctx.platform.call<{ admin: { user: UserBody } }>('POST', 'platform/tenants', {
        tenantId,
        name: spec.name,
        adminEmail: spec.adminEmail,
      }),
    );
    if (r.status === 201) {
      return r.body.admin.user.username;
    }
    if (r.status === 429) {
      await sleep(Math.min(8000, 400 * 2 ** attempt) * (0.5 + Math.random()));
      continue;
    }
    if (r.status === 409 || r.status === 503 || r.status === 0) {
      const t = await withRetry(() =>
        timed(rec, 'get-tenant', tenantId, () => ctx.platform.call<{ tenant: { status: string } }>('GET', `platform/tenants/${tenantId}`)),
      );
      if (t.status === 200 && t.body.tenant.status === 'ACTIVE') {
        return createUser(ctx, rec, tenantId, spec.adminEmail, true);
      }
      await sleep(Math.min(8000, 400 * 2 ** attempt) * (0.5 + Math.random()));
      continue; // 404: nothing was written, or it is still PROVISIONING
    }
    rec.finding(`CreateTenant for tenant ${tenantId}: HTTP ${r.status}`);
    return undefined;
  }
  rec.finding(`CreateTenant for tenant ${tenantId}: not ACTIVE after 12 attempts`);
  return undefined;
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** IssueToken (ADR-0006, a test aid): sets the user's password and signs in. */
export async function issueToken(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  username: string,
  password: string,
): Promise<Tokens | undefined> {
  const r = await withRetry(() =>
    timed(rec, 'issue-token', tenantId, () =>
      ctx.platform.call<Tokens>('POST', `platform/tenants/${tenantId}/users/${username}/token`, { password })),
  );
  if (r.status === 200) {
    return { accessToken: r.body.accessToken, refreshToken: r.body.refreshToken };
  }
  rec.finding(`IssueToken for tenant ${tenantId}: HTTP ${r.status}`);
  return undefined;
}

/** DELETE tenant, retried until 204 or 404 (DeleteTenant resumes where it stopped). */
export async function deleteTenant(ctx: Ctx, rec: Recorder, tenantId: string): Promise<boolean> {
  const r = await withRetry(
    () => timed(rec, 'delete-tenant', tenantId, () => ctx.platform.call('DELETE', `platform/tenants/${tenantId}`)),
    (s) => RETRYABLE(s) || s === 504,
    8,
  );
  if (r.status === 204 || r.status === 404) {
    return true;
  }
  rec.finding(`DeleteTenant for tenant ${tenantId}: HTTP ${r.status}`);
  return false;
}

// ---------------------------------------------------------------------------
// Isolation assertions (P-1)
// ---------------------------------------------------------------------------

/**
 * Verifies a token against the stress pool and asserts it names `tenantId`
 * and carries no Cognito groups claim (ADR-0020). Returns the claims.
 */
export async function assertTokenTenant(
  ctx: Ctx,
  rec: Recorder,
  token: string,
  tenantId: string,
  what: string,
  scope?: string,
): Promise<Record<string, unknown> | undefined> {
  let claims: Record<string, unknown>;
  try {
    claims = await ctx.verifier.verify(token);
  } catch {
    rec.assertIsolation(false, `${what}: the token did not verify against the stress pool`, tenantId);
    return undefined;
  }
  rec.assertIsolation(claims.tenant_id === tenantId, `${what}: tenant_id names another tenant`, tenantId);
  rec.assertIsolation(claims['cognito:groups'] === undefined && claims.tenants === undefined, `${what}: the token carries a groups or tenants claim`, tenantId);
  if (scope !== undefined) {
    rec.assertIsolation(String(claims.scope ?? '').split(' ').includes(scope), `${what}: the token lacks scope ${scope}`, tenantId);
  }
  return claims;
}

const REFUSED = (status: number): boolean => status === 400 || status === 401 || status === 403 || status === 404 || status === 409;

/**
 * Asserts a call that must be refused was refused. A throttle or a server
 * error is not an answer: it is retried, and if it never gives one the
 * assertion is not made and a finding records the gap.
 */
function assertRefused(rec: Recorder, tenantId: string, what: string, r: HttpResult<unknown>): void {
  if (REFUSED(r.status) || (r.status >= 200 && r.status < 300)) {
    rec.assertIsolation(REFUSED(r.status), `${what}: not refused (HTTP ${r.status})`, tenantId);
  } else {
    rec.finding(`${what} for tenant ${tenantId}: no answer (HTTP ${r.status})`);
  }
}

/** A tenant's refresh token used through another tenant's path: membership check, ADR-0013. */
export async function probeForeignRefresh(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  foreignTenantId: string,
  username: string,
  refreshToken: string,
): Promise<void> {
  const r = await withRetry(() =>
    timed(rec, 'probe-foreign-refresh', tenantId, () =>
      ctx.platform.call<{ accessToken?: string }>('POST', `platform/tenants/${foreignTenantId}/users/${username}/token/refresh`, { refreshToken })),
  );
  assertRefused(rec, tenantId, 'RefreshToken through another tenant', r);
}

/**
 * Tenant A's refresh token on tenant B's path, with the name of a real user
 * of B, so the membership check (ADR-0013) passes and the refresh token
 * itself is what is tested. It must be refused, or any token it returns must
 * name A, never B (P-1). `RefreshToken` does not tie the refresh token to the
 * path's user, so a served answer carrying A's tenant is noted, not a
 * mismatch (ADR-0041).
 */
export async function probeForeignRefreshToken(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  foreignTenantId: string,
  foreignUsername: string,
  refreshToken: string,
): Promise<void> {
  const what = 'RefreshToken of another tenant on its own path';
  const r = await withRetry(() =>
    timed(rec, 'probe-foreign-refresh-token', tenantId, () =>
      ctx.platform.call<{ accessToken?: string }>('POST', `platform/tenants/${foreignTenantId}/users/${foreignUsername}/token/refresh`, { refreshToken })),
  );
  if (r.status >= 200 && r.status < 300) {
    const token = r.body?.accessToken;
    if (token === undefined) {
      rec.finding(`${what} for tenant ${tenantId}: HTTP ${r.status} without a token`);
      return;
    }
    await assertTokenTenant(ctx, rec, token, tenantId, `${what}: served`);
    rec.note(`${what}: served, the answer named the caller's tenant`);
    return;
  }
  assertRefused(rec, tenantId, what, r);
}

/** A tenant's refresh token exchanged for another tenant's resource. */
export async function probeForeignExchange(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  foreignTenantId: string,
  refreshToken: string,
): Promise<void> {
  const r = await withRetry(() =>
    timed(rec, 'probe-foreign-exchange', tenantId, () =>
      ctx.exchange.exchange({
        clientId: ctx.clientId,
        subjectToken: refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(foreignTenantId),
      })),
  );
  assertRefused(rec, tenantId, 'ExchangeToken for another tenant', r);
}

/**
 * The tenant admin door with tenant A's narrowed token: it lists only users of
 * A, and it cannot read a user of B.
 */
export async function probeTenantDoor(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  narrowedToken: string,
  ownUsers: readonly ManifestUser[],
  foreignUsername: string,
): Promise<void> {
  const list = await timed(rec, 'tenant-door', tenantId, () =>
    ctx.tenantApi.call<{ users: UserBody[] }>('GET', 'tenant/users', narrowedToken));
  if (list.status === 200) {
    const own = new Set(ownUsers.map((u) => u.username));
    rec.assertIsolation(list.body.users.every((u) => own.has(u.username)), 'the admin door listed a user of another tenant', tenantId);
  } else if (list.status !== 429) {
    rec.finding(`ListTenantUsers for tenant ${tenantId}: HTTP ${list.status}`);
  }
  const foreign = await timed(rec, 'tenant-door', tenantId, () =>
    ctx.tenantApi.call('GET', `tenant/users/${foreignUsername}`, narrowedToken));
  if (foreign.status !== 429) {
    assertRefused(rec, tenantId, 'GetTenantUser of another tenant', foreign);
  }
}

/** Exchanges a refresh token for the tenant-admin narrowed token of `tenantId`. */
export async function exchangeAdmin(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  refreshToken: string,
  retry: boolean,
): Promise<HttpResult<{ access_token?: string }>> {
  const call = (): Promise<HttpResult<{ access_token?: string }>> =>
    timed(rec, 'token-exchange', tenantId, () =>
      ctx.exchange.exchange({
        clientId: ctx.clientId,
        subjectToken: refreshToken,
        scope: SCOPE_TENANT_ADMIN,
        resource: tenantResource(tenantId),
      }) as Promise<HttpResult<{ access_token?: string }>>);
  return retry ? withRetry(call) : call();
}

/** RefreshToken through the platform API. */
export async function platformRefresh(
  ctx: Ctx,
  rec: Recorder,
  tenantId: string,
  username: string,
  token: string,
): Promise<HttpResult<{ accessToken?: string }>> {
  return timed(rec, 'platform-refresh', tenantId, () =>
    ctx.platform.call<{ accessToken?: string }>('POST', `platform/tenants/${tenantId}/users/${username}/token/refresh`, { refreshToken: token }));
}
