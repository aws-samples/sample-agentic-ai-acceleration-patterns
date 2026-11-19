// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant-identity slice's scenarios (docs/stress-test.spec.md §5.1, §5.2):
 *
 *   PS-1                 the identity step of onboarding, at the tier's churn count
 *   token-rate           token issue, refresh and exchange at the tier's steady rate
 *   create-tenant-burst  CreateTenant beyond what Cognito's control plane takes (F-3)
 *
 * Every scenario asserts P-1 on every token it touches (the token names the
 * tenant it was issued for) and probes the other way (a token or a path of
 * tenant A never works for tenant B). Findings that are not isolation
 * assertions (an operation that never finished, a bare 5xx) fail the scenario
 * through the Recorder.
 */

import { ulid } from 'ulid';
import type { ManifestTenant, ManifestUser } from './manifest';
import {
  assertTokenTenant,
  createTenantWithAdmin,
  createUser,
  type Ctx,
  deleteTenant,
  exchangeAdmin,
  issueToken,
  Pacer,
  probeForeignExchange,
  probeForeignRefresh,
  probeForeignRefreshToken,
  probeTenantDoor,
  randomPassword,
  platformRefresh,
  runPool,
  sleep,
  type Tokens,
} from './ops';
import { GROUPS_PER_TENANT, ISSUE_PACE_PER_SECOND, type Plan } from './plan';
import type { Recorder } from './recorder';
import { SCOPE_TENANT_ADMIN } from '../../src/shared/constants';

/** What a scenario needs from the manifest: the steady set, and a place to note transient tenants. */
export interface Store {
  readonly seeded: readonly ManifestTenant[];
  /** Records tenant ids a scenario is about to create, before it creates them. */
  addTransient(ids: readonly string[]): void;
  removeTransient(ids: readonly string[]): void;
}

export interface ScenarioEnv {
  readonly ctx: Ctx;
  readonly plan: Plan;
  readonly rec: Recorder;
  readonly store: Store;
  readonly prefix: string;
  /** Short, unique per run: part of the names and e-mail addresses a scenario creates. */
  readonly tag: string;
}

/** E-mail addresses are SES simulator addresses with plus addressing (no mail is sent anyway). */
export function emailOf(prefix: string, tag: string, name: string): string {
  return `success+${prefix}-${tag}-${name}@simulator.amazonses.com`.toLowerCase();
}

interface Onboarded {
  readonly tenant: ManifestTenant;
  readonly tokens: Map<string, Tokens>;
}

/**
 * Creates `ids.length` tenants, `concurrency` at a time. For each: the tenant
 * and its admin, the extra users, a token for every user and the P-1 check on
 * it. Returns what completed, in `ids` order; a tenant that did not complete
 * is a finding and absent.
 */
async function onboardAll(
  env: ScenarioEnv,
  kind: string,
  ids: readonly string[],
  concurrency: number,
  extraUsers: number,
  password: string,
): Promise<(Onboarded | undefined)[]> {
  const { ctx, rec, prefix, tag } = env;
  const out: (Onboarded | undefined)[] = new Array<Onboarded | undefined>(ids.length).fill(undefined);
  await runPool(ids, concurrency, async (tenantId, i) => {
    const t0 = performance.now();
    const name = `${kind}-${String(i).padStart(4, '0')}`;
    const adminEmail = emailOf(prefix, tag, `${name}-a`);
    const adminName = await createTenantWithAdmin(ctx, rec, { tenantId, name: `${prefix}-${tag}-${name}`, adminEmail });
    if (adminName === undefined) {
      return;
    }
    const users: ManifestUser[] = [];
    for (let k = 1; k <= extraUsers; k += 1) {
      const email = emailOf(prefix, tag, `${name}-u${k}`);
      const username = await createUser(ctx, rec, tenantId, email);
      if (username === undefined) {
        return;
      }
      users.push({ username, email });
    }
    const admin: ManifestUser = { username: adminName, email: adminEmail };
    const tokens = new Map<string, Tokens>();
    for (const user of [admin, ...users]) {
      const issued = await issueToken(ctx, rec, tenantId, user.username, password);
      if (issued === undefined) {
        return;
      }
      await assertTokenTenant(ctx, rec, issued.accessToken, tenantId, 'IssueToken');
      tokens.set(user.username, issued);
    }
    rec.sample('onboard-ready', (performance.now() - t0) / 1000);
    out[i] = { tenant: { tenantId, name, admin, users }, tokens };
  });
  return out;
}

/**
 * Each tenant's admin refresh token against the next tenant: on its path with
 * the caller's own name, on its path with the next tenant's admin name, and
 * exchanged for its resource.
 */
async function probeNeighbours(env: ScenarioEnv, done: readonly Onboarded[], fallbackForeign: ManifestTenant | undefined): Promise<void> {
  const { ctx, rec } = env;
  await runPool(done, 10, async (o, i) => {
    const foreign = done.length > 1 ? done[(i + 1) % done.length].tenant : fallbackForeign;
    const token = o.tokens.get(o.tenant.admin.username);
    if (foreign === undefined || token === undefined) {
      return;
    }
    await probeForeignRefresh(ctx, rec, o.tenant.tenantId, foreign.tenantId, o.tenant.admin.username, token.refreshToken);
    await probeForeignRefreshToken(ctx, rec, o.tenant.tenantId, foreign.tenantId, foreign.admin.username, token.refreshToken);
    await probeForeignExchange(ctx, rec, o.tenant.tenantId, foreign.tenantId, token.refreshToken);
  });
}

async function removeAll(env: ScenarioEnv, ids: readonly string[]): Promise<void> {
  await runPool(ids, 10, async (id) => {
    if (await deleteTenant(env.ctx, env.rec, id)) {
      env.store.removeTransient([id]);
    }
  });
}

/** A batch: onboard, probe across tenants, delete. Shared by PS-1 and the burst. */
async function batch(env: ScenarioEnv, kind: string, count: number, concurrency: number): Promise<void> {
  const { plan, rec, store } = env;
  const ids = Array.from({ length: count }, () => ulid());
  store.addTransient(ids);
  const password = randomPassword();
  rec.quotaPeak('cognito-groups', GROUPS_PER_TENANT * (store.seeded.length + count));
  const done = (await onboardAll(env, kind, ids, concurrency, plan.extraUsers, password)).filter(
    (o): o is Onboarded => o !== undefined,
  );
  if (done.length !== count) {
    rec.finding(`${kind}: ${count - done.length} of ${count} tenants did not finish onboarding`);
  }
  await probeNeighbours(env, done, store.seeded[0]);
  await removeAll(env, ids);
}

/**
 * PS-1, the identity step: the tier's churn count of tenants onboarded at
 * once (the control plane's build limit, at most 50 at a time): tenant,
 * admin, users, first token, each token checked. Time to ready is the
 * `onboard-ready` hop.
 */
export async function ps1(env: ScenarioEnv): Promise<void> {
  await batch(env, 'ob', env.plan.onboardTenants, env.plan.onboardConcurrency);
}

/**
 * create-tenant-burst (runtime-isolation finding F-3): four times the churn
 * count of CreateTenant calls, all at once. Throttles (429, and 503 from
 * ADR-0037) are expected and counted; what must hold is that no call ends in
 * a bare 500, every tenant ends ACTIVE with its admin (the ADR-0037 recovery),
 * and every token still names its own tenant.
 */
export async function createTenantBurst(env: ScenarioEnv): Promise<void> {
  await batch(env, 'burst', env.plan.burstTenants, env.plan.burstConcurrency);
}

/** Ops per second that reached Cognito, for the quota peak. */
class PerSecond {
  private readonly buckets = new Map<number, number>();
  hit(): void {
    const s = Math.floor(Date.now() / 1000);
    this.buckets.set(s, (this.buckets.get(s) ?? 0) + 1);
  }

  get peak(): number {
    return Math.max(0, ...this.buckets.values());
  }
}

const MAX_INFLIGHT = 200;

/**
 * token-rate: the tier's steady rate for its scenario length, as an open-loop
 * mix over the active seeded tenants. Per five calls: two admin exchanges
 * (`/oauth2/token`), two platform refreshes, one probe in rotation (a foreign
 * exchange, a foreign refresh path, a foreign user's path with the caller's
 * refresh token, the tenant admin door). A 429 or 503 is a
 * result (the throttle it measures), not retried.
 */
export async function tokenRate(env: ScenarioEnv): Promise<void> {
  const { ctx, plan, rec, store } = env;
  const tenants = store.seeded.slice(0, plan.activeTenants);
  if (tenants.length < 2) {
    rec.finding('token-rate needs at least two seeded tenants: run seed first');
    return;
  }
  // Prepare: a refresh token for every user, paced under the platform throttle.
  const password = randomPassword();
  const pacer = new Pacer(ISSUE_PACE_PER_SECOND);
  const refresh = new Map<string, Tokens>();
  await runPool(
    tenants.flatMap((t) => [t.admin, ...t.users].map((u) => ({ tenantId: t.tenantId, user: u }))),
    4,
    async ({ tenantId, user }) => {
      await pacer.wait();
      const issued = await issueToken(ctx, rec, tenantId, user.username, password);
      if (issued !== undefined) {
        await assertTokenTenant(ctx, rec, issued.accessToken, tenantId, 'IssueToken');
        refresh.set(user.username, issued);
      }
    },
  );

  const narrowed = new Map<string, string>();
  const cognito = new PerSecond();

  const op = async (i: number): Promise<void> => {
    const t = tenants[Math.floor(i / 5) % tenants.length];
    const other = tenants[(Math.floor(i / 5) + 1) % tenants.length];
    const adminTokens = refresh.get(t.admin.username);
    const memberName = (t.users[0] ?? t.admin).username;
    const memberTokens = refresh.get(memberName);
    switch (i % 5) {
      case 0:
      case 1: {
        if (adminTokens === undefined) return;
        cognito.hit();
        const r = await exchangeAdmin(ctx, rec, t.tenantId, adminTokens.refreshToken, false);
        if (r.status === 200 && r.body.access_token !== undefined) {
          narrowed.set(t.tenantId, r.body.access_token);
          await assertTokenTenant(ctx, rec, r.body.access_token, t.tenantId, 'ExchangeToken', SCOPE_TENANT_ADMIN);
        }
        return;
      }
      case 2:
      case 3: {
        const who = i % 5 === 2 ? memberName : t.admin.username;
        const tokens = i % 5 === 2 ? memberTokens : adminTokens;
        if (tokens === undefined) return;
        cognito.hit();
        const r = await platformRefresh(ctx, rec, t.tenantId, who, tokens.refreshToken);
        if (r.status === 200 && r.body.accessToken !== undefined) {
          await assertTokenTenant(ctx, rec, r.body.accessToken, t.tenantId, 'RefreshToken');
        }
        return;
      }
      default: {
        if (adminTokens === undefined) return;
        switch (Math.floor(i / 5) % 4) {
          case 0:
            cognito.hit();
            await probeForeignExchange(ctx, rec, t.tenantId, other.tenantId, adminTokens.refreshToken);
            return;
          case 1:
            await probeForeignRefresh(ctx, rec, t.tenantId, other.tenantId, memberName, (memberTokens ?? adminTokens).refreshToken);
            return;
          case 2:
            cognito.hit();
            await probeForeignRefreshToken(ctx, rec, t.tenantId, other.tenantId, other.admin.username, adminTokens.refreshToken);
            return;
          default: {
            let token = narrowed.get(t.tenantId);
            if (token === undefined) {
              cognito.hit();
              const r = await exchangeAdmin(ctx, rec, t.tenantId, adminTokens.refreshToken, true);
              token = r.body?.access_token;
              if (token === undefined) return;
              narrowed.set(t.tenantId, token);
            }
            await probeTenantDoor(ctx, rec, t.tenantId, token, [t.admin, ...t.users], other.admin.username);
          }
        }
      }
    }
  };

  const seconds = plan.tier.scenarioSeconds;
  const start = performance.now();
  const inflight = new Set<Promise<void>>();
  for (let i = 0; (performance.now() - start) / 1000 < seconds; i += 1) {
    const wait = start + (i * 1000) / plan.tier.steadyRps - performance.now();
    if (wait > 0) {
      await sleep(wait);
    }
    while (inflight.size >= MAX_INFLIGHT) {
      await Promise.race(inflight);
    }
    const p: Promise<void> = op(i)
      .catch((e: unknown) => rec.finding(`token-rate op ${i}: ${(e as Error).name}`))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  rec.quotaPeak('cognito-user-authentication-rps', cognito.peak);
}
