// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's scenarios (platform stress test, docs/stress-test.spec.md §5.1
 * PS-1 and §5.2): onboarding (its share of PS-1, and the cell build time of spec Q-1),
 * placement races on a nearly full fleet, the read rate under writes, and onboarding rate at
 * build limits 5, 20 and 50. PS-5, the churn of tenants through the edge, is in `churn.ts`.
 * Every scenario makes isolation assertions (P-1) and leaves the
 * fleet as it found it, apart from PS-1, which onboards the seeded tenants for the rest.
 */

import type { CallResult } from './api';
import { sleep } from './aws';
import { ps5 } from './churn';
import type { Edge } from './edge';
import {
  assertPlaced,
  cellsOf,
  CONFLICT_FAILURE,
  type CellState,
  type DeploymentState,
  deploymentsOf,
  expectStatus,
  type FleetEnv,
  onboardSeconds,
  paced,
  type Placement,
  placeDeployment,
  removeAll,
  waitDeployments,
} from './fleet';
import type { IdentityApi } from './identity';
import type { IdentityEntry, Manifest } from './manifest';
import { scalingLimitsFor, type TierSizes } from './plan';
import { NO_TENANT } from './recorder';

export interface ScenarioEnv extends FleetEnv {
  readonly tier: TierSizes;
  readonly manifest: Manifest;
  readonly buildLimit: number;
  /** Redeploys the control plane with another concurrent build limit (slice.sh set-build-limit). */
  readonly setBuildLimit: (limit: number) => Promise<number>;
  /** The front door's edge and route registrar, for PS-5 (platform mode only; `edge.ts`). */
  readonly edge?: Edge;
  /** The stress identity and the edge, for PS-1 in a platform run (stress ADR-0017). */
  readonly platform?: PlatformEnv;
}

/** What PS-1 needs in a platform run, beside the control plane: the stress identity and, with the front door in the run, the edge. */
export interface PlatformEnv {
  readonly identity: IdentityApi;
  /** Users per tenant, the admin counted (spec §4.1). */
  readonly users: number;
  /** The front door's https origin; absent when the run has no front door (the identity is created, nothing is polled). */
  readonly edgeUrl?: string;
  /** The identity tenant the manifest already holds for a control-plane tenant. */
  readonly existing: (tenantId: string) => IdentityEntry | undefined;
  /** Records a created identity tenant in the manifest, at once, so teardown finds it after any failure. */
  readonly save: (entry: IdentityEntry) => void;
  /** Writes the tenant's row in the cell's demo table, which the agent's `read <tenant>` probe reads (spec §5.3, credential check). */
  readonly seedData?: (tenantId: string) => Promise<void>;
}

/** A cell build plus its first tenant build: Q-1 expects about eight minutes; one hour is the build budget. */
const CELL_TIMEOUT_SECONDS = 3600;
/** A wave of tenant builds at a build limit: rounds of about two minutes each, with margin. */
const waveTimeout = (tenants: number, limit: number): number => 600 + Math.ceil(tenants / limit) * 240;
const enc = encodeURIComponent;
const TERMINAL = /^(ACTIVE|[A-Z]+_FAILED)$/;

/**
 * Places every tenant: first one alone when the application has no ACTIVE cell, so its
 * cell build is timed by itself (spec Q-1), then the rest at once. A tenant refused with
 * `InsufficientCapacityError` while a cell of the application is still being created is
 * tried again once that cell is ACTIVE (a new cell takes no placement until then).
 */
interface Onboarded {
  readonly placed: string[];
  readonly full: string[];
  readonly failed: string[];
  readonly waveSeconds: number;
}

async function onboard(s: ScenarioEnv, tenants: readonly string[], hop: string): Promise<Onboarded> {
  const started = Date.now();
  const placed: string[] = [];
  const failed: string[] = [];
  let pending = [...tenants];
  const cells = await cellsOf(s);
  if (pending.length > 0 && !cells.some((c) => c.status === 'ACTIVE')) {
    const first = pending.shift()!;
    const result = await placeDeployment(s, first);
    if (result === 'accepted' || result === 'exists') {
      placed.push(first);
      const firstCellStart = Date.now();
      const done = await waitDeployments(s, [first], { timeoutSeconds: CELL_TIMEOUT_SECONDS });
      const d = done.get(first);
      const cell = (await cellsOf(s)).find((c) => c.cellId === d?.cellId);
      if (cell?.createdAt !== undefined && cell.updatedAt !== undefined && cell.status === 'ACTIVE') {
        s.rec.sample('cell-create', (Date.parse(cell.updatedAt) - Date.parse(cell.createdAt)) / 1000);
      }
      s.log(`first deployment ${d?.status ?? 'missing'} after ${Math.round((Date.now() - firstCellStart) / 1000)} s; cell ${cell?.status ?? 'missing'}`);
    } else {
      failed.push(first);
    }
  }
  // The rest at most the build limit at a time (`paced`). A tenant refused with
  // `InsufficientCapacityError` while a cell of the application is still being created is
  // tried again once that cell is ACTIVE; one whose create failed on a transaction conflict
  // is removed and created again (stress ADR-0013), at most twice.
  const full: string[] = [];
  const timeout = CELL_TIMEOUT_SECONDS + waveTimeout(pending.length, s.buildLimit);
  const tries = new Map<string, number>();
  for (let round = 0; pending.length > 0 && round < 12; round += 1) {
    const results = new Map<string, Placement>();
    await paced(s, pending, s.buildLimit, timeout, async (t) => {
      const r = await placeDeployment(s, t);
      results.set(t, r);
      return r === 'accepted' || r === 'exists';
    }, (d) => d === undefined || TERMINAL.test(d.status));
    const retry: string[] = [];
    const all = await deploymentsOf(s);
    for (const t of pending) {
      const r = results.get(t);
      const d = all.get(t);
      if (r === 'full') {
        retry.push(t);
      } else if (r !== 'accepted' && r !== 'exists') {
        failed.push(t);
      } else if (d?.status === 'CREATE_FAILED' && CONFLICT_FAILURE.test(d.statusReason ?? '') && (tries.get(t) ?? 0) < 2) {
        tries.set(t, (tries.get(t) ?? 0) + 1);
        s.rec.count('CREATE_FAILED:retried');
        await removeAll(s, [t], s.buildLimit, waveTimeout(1, s.buildLimit));
        retry.push(t);
      } else if (!placed.includes(t)) {
        placed.push(t);
      }
    }
    if (retry.length === 0) break;
    const creating = (await cellsOf(s)).some((c) => c.status === 'CREATING');
    const capacity = retry.filter((t) => results.get(t) === 'full');
    if (capacity.length > 0 && !creating) {
      full.push(...capacity);
      pending = retry.filter((t) => !capacity.includes(t));
    } else {
      pending = retry;
    }
    if (pending.length > 0 && capacity.length > 0) await sleep(30_000);
  }
  const states = await waitDeployments(s, placed, { timeoutSeconds: waveTimeout(placed.length, s.buildLimit) });
  for (const [t, d] of states) {
    if (d === undefined || d.status !== 'ACTIVE') {
      s.rec.finding(`tenant ${t}: deployment ${d?.status ?? 'missing'} (${String(d?.statusReason ?? 'no reason').slice(0, 160)})`);
    } else {
      s.rec.sample(hop, onboardSeconds(d));
    }
  }
  if (failed.length > 0) s.rec.finding(`${failed.length} CreateDeployment calls failed`);
  return { placed, full, failed, waveSeconds: (Date.now() - started) / 1000 };
}

async function assertFleet(s: ScenarioEnv, tenants: readonly string[]): Promise<{ deployments: Map<string, DeploymentState>; cells: CellState[] }> {
  const [deployments, cells] = await Promise.all([deploymentsOf(s), cellsOf(s)]);
  const active = tenants.map((t) => deployments.get(t)).filter((d): d is DeploymentState => d?.status === 'ACTIVE');
  await assertPlaced(s, active, cells);
  return { deployments, cells };
}

/** Removes the tenants' deployments and waits until they are gone. */
async function offboard(s: ScenarioEnv, tenants: readonly string[]): Promise<void> {
  const stuck = await removeAll(s, tenants, s.buildLimit, waveTimeout(tenants.length, s.buildLimit));
  if (stuck.length > 0) s.rec.finding(`${stuck.length} deployments still there after three deletes`);
}

/** How many tenants get their identity and first served request at once; the identity calls are paced anyway (`IDENTITY_CALLS_PER_SECOND`). */
const READY_CONCURRENCY = 4;
/** A tenant's route reaches the edge within about a minute (front-door spec §3.4); five minutes is the budget. */
const READY_TIMEOUT_SECONDS = 300;
/** The stress identity's access tokens live five minutes (tenant-identity); a poll that runs longer asks for a new one. */
const TOKEN_REUSE_MS = 200_000;

interface Whoami {
  readonly status: number;
  readonly body: any;
  readonly seconds: number;
}

/** One `GET /api/whoami` through the edge. Never throws; status 0 is no answer. */
async function whoamiOnce(edgeUrl: string, token: string): Promise<Whoami> {
  const started = process.hrtime.bigint();
  try {
    const res = await fetch(`${edgeUrl}/api/whoami`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
  } catch {
    return { status: 0, body: undefined, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
  }
}

/**
 * A control-plane tenant that is ACTIVE gets its identity (stress ADR-0017) and then asks the
 * edge for `/api/whoami` until it is served (spec §3.3 step 4): the time from `CreateDeployment`
 * to that answer is the tenant's PS-1 time (`ready`). The answer is an isolation assertion
 * at the edge and the cell (spec §5.3): the verified tenant is this tenant and the route hint
 * the router sent names it. A tenant whose identity could not be made, or that is never
 * served, is a finding.
 */
async function becomeReady(s: ScenarioEnv, p: PlatformEnv, tenant: string, createdAtMs: number, hop: 'ready' | 'warm-up-ready'): Promise<void> {
  const identityStarted = Date.now();
  let entry = p.existing(tenant);
  if (entry === undefined) {
    entry = await p.identity.createIdentity(tenant, `st-${tenant.slice(-12).toLowerCase()}`, Math.max(0, p.users - 1));
    if (entry === undefined) {
      s.rec.finding(`tenant ${tenant}: its identity tenant could not be made`);
      return;
    }
    p.save(entry);
  }
  // The demo row the agent's credential check reads: made with the identity, before the first served call.
  if (p.seedData !== undefined) {
    try {
      await p.seedData(tenant);
    } catch (e) {
      s.rec.finding(`tenant ${tenant}: its demo data could not be written (${e instanceof Error ? e.name : 'error'})`);
    }
  }
  s.rec.sample('identity', (Date.now() - identityStarted) / 1000);
  if (p.edgeUrl === undefined) return;
  let token: string | undefined;
  let issuedAt = 0;
  const deadline = Date.now() + READY_TIMEOUT_SECONDS * 1000;
  for (;;) {
    if (token === undefined || Date.now() - issuedAt > TOKEN_REUSE_MS) {
      token = await p.identity.issueToken(tenant, entry.admin.username);
      issuedAt = Date.now();
      if (token === undefined) {
        s.rec.finding(`tenant ${tenant}: no token for ${hop}`);
        return;
      }
    }
    const r = await whoamiOnce(p.edgeUrl, token);
    s.rec.observe('edge-whoami', { status: r.status, body: r.body, seconds: r.seconds }, tenant, false);
    if (r.status === 200) {
      s.rec.assertIsolation(String(r.body?.tenantId ?? '').toUpperCase() === tenant, `the cell answered for tenant ${String(r.body?.tenantId)}`, tenant);
      s.rec.assertIsolation(String(r.body?.routeHint ?? '') === tenant.toLowerCase(), 'the route hint the router sent does not name the token\'s tenant', tenant);
      s.rec.sample(hop, (Date.now() - createdAtMs) / 1000);
      return;
    }
    if (Date.now() > deadline) {
      s.rec.finding(`tenant ${tenant}: not served through the edge within ${READY_TIMEOUT_SECONDS} s (last HTTP ${r.status})`);
      return;
    }
    await sleep(2000);
  }
}

/**
 * Starts the identity and readiness work of each tenant as its deployment turns ACTIVE, so a
 * tenant's `ready` time does not wait for the rest of the wave. `finish` stops looking, reads
 * once more and waits for every started tenant.
 */
function startReadiness(s: ScenarioEnv, p: PlatformEnv, tenants: readonly string[]): { finish: () => Promise<void> } {
  const queued = new Set<string>();
  const jobs: Promise<void>[] = [];
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<void> => {
    if (running >= READY_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
  };
  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };
  const tick = async (): Promise<void> => {
    const all = await deploymentsOf(s);
    for (const t of tenants) {
      const d = all.get(t);
      if (d?.status !== 'ACTIVE' || queued.has(t)) continue;
      queued.add(t);
      jobs.push((async () => {
        await slot();
        try {
          await becomeReady(s, p, t, Date.parse(d.createdAt), 'ready');
        } finally {
          release();
        }
      })());
    }
  };
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await tick().catch((e: unknown) => s.rec.finding(`reading the deployments for readiness failed: ${(e as Error).message}`));
      for (let i = 0; i < 10 && !stopped; i += 1) await sleep(1000);
    }
  })();
  return {
    async finish() {
      stopped = true;
      await loop;
      await tick();
      await Promise.all(jobs);
    },
  };
}

/**
 * PS-1 in a platform run (spec §3.5 steps 5 to 7, §5.1): the warm-up tenant, which the `warm-up`
 * step placed alone to build the cell, gets its identity first and is not part of the timed
 * wave; the other seeded tenants are onboarded at the build limit, each gets its identity as
 * its deployment turns ACTIVE, and the time from `CreateDeployment` to the first served
 * `/api/whoami` through the edge is the `ready` hop. The front door's phase two ran before
 * this scenario, so the agent path is open for the tenants that follow (PS-2 and the rest).
 */
async function ps1Platform(s: ScenarioEnv, p: PlatformEnv): Promise<void> {
  const warm = s.manifest.warmUp!;
  if (s.tier.onboarding === 'fixture') s.rec.finding('PS-1 in a platform run at a fixture tier is not built: the fleet is a fixture, so its tenants have identities already (spec §5.1)');
  const existing = await deploymentsOf(s);
  const warmDeployment = existing.get(warm.tenantId);
  if (warmDeployment?.status !== 'ACTIVE') s.rec.finding(`the warm-up tenant ${warm.tenantId} has no ACTIVE deployment: run the warm-up step first`);
  else await becomeReady(s, p, warm.tenantId, Date.parse(warmDeployment.createdAt), 'warm-up-ready');
  const others = s.manifest.seeded.filter((t) => t !== warm.tenantId);
  // A tenant that is ACTIVE already (a rerun) is not placed again but still gets its identity and its first served call.
  const tenants = others.filter((t) => existing.get(t)?.status !== 'ACTIVE');
  const watcher = startReadiness(s, p, others);
  let r: Onboarded;
  try {
    r = await onboard(s, tenants, 'onboard');
  } finally {
    await watcher.finish();
  }
  s.rec.sample('wave', r.waveSeconds);
  if (r.full.length > 0) s.rec.finding(`${r.full.length} tenants found the fleet full during onboarding`);
  s.log(`PS-1: ${r.placed.length} of ${tenants.length} placed in ${Math.round(r.waveSeconds)} s (${(r.placed.length / Math.max(r.waveSeconds / 60, 1 / 60)).toFixed(1)} deployments a minute), warm-up tenant apart`);
  await assertFleet(s, s.manifest.seeded);
}

/**
 * PS-1 onboarding (spec §5.1), the control plane's share: the seeded tenants onboarded at
 * the build limit. Hops: `create-deployment` (the API call), `onboard` (CreateDeployment to
 * ACTIVE, from the record's own timestamps), `cell-create` (a new cell's CREATING to ACTIVE,
 * spec Q-1) and `wave` (the whole batch). At a fixture tier whose seeded fleet is already
 * there, the churn tenants are onboarded and removed instead (spec §5.1). In a platform run
 * (`s.platform` and a warm-up tenant in the manifest) each tenant also gets its identity and is
 * polled until the edge serves it (`ps1Platform`).
 */
export async function ps1(s: ScenarioEnv): Promise<void> {
  if (s.platform !== undefined && s.manifest.warmUp !== undefined) return ps1Platform(s, s.platform);
  const existing = await deploymentsOf(s);
  let tenants = s.manifest.seeded.filter((t) => existing.get(t)?.status !== 'ACTIVE');
  const fixture = tenants.length === 0 && s.tier.onboarding === 'fixture';
  if (fixture) tenants = [...s.manifest.churn];
  const r = await onboard(s, tenants, 'onboard');
  s.rec.sample('wave', r.waveSeconds);
  if (r.full.length > 0) s.rec.finding(`${r.full.length} tenants found the fleet full during onboarding`);
  s.log(`PS-1: ${r.placed.length} of ${tenants.length} placed in ${Math.round(r.waveSeconds)} s (${(r.placed.length / Math.max(r.waveSeconds / 60, 1 / 60)).toFixed(1)} deployments a minute)`);
  await assertFleet(s, s.manifest.seeded);
  if (fixture) await offboard(s, tenants);
}

/**
 * Placement race (spec §5.2): the churn and extra tenants all call CreateDeployment at once
 * on a fleet with exactly as many free slots as there are churn tenants. Exactly that many
 * must be placed and the rest refused with `InsufficientCapacityError` (attributed refusals,
 * P-7); no cell may go over its `maxTenants`, and every refused tenant must have no
 * deployment. The placed deployments are then removed again.
 */
export async function placementRace(s: ScenarioEnv): Promise<void> {
  const cells = await cellsOf(s);
  const accounts = s.cellAccounts.length;
  const room = cells.filter((c) => c.status === 'ACTIVE').reduce((n, c) => n + (c.maxTenants - c.tenantCount), 0);
  const cellSlotsLeft = s.tier.cells - cells.length;
  if (cellSlotsLeft > 0) {
    s.rec.finding(`the fleet has ${cells.length} of ${s.tier.cells} cells across ${accounts} accounts: run PS-1 first, so the race meets a nearly full fleet`);
  }
  const racers = [...s.manifest.churn, ...s.manifest.extra];
  const results = await Promise.all(racers.map((t) => placeDeployment(s, t, 'create-deployment-race')));
  const placed = racers.filter((_, i) => results[i] === 'accepted');
  const refused = racers.filter((_, i) => results[i] === 'full');
  s.log(`placement race: ${racers.length} racers on ${room} free slots: ${placed.length} placed, ${refused.length} refused`);
  s.rec.assertIsolation(placed.length === Math.min(room, racers.length), `${placed.length} placed on ${room} free slots`, NO_TENANT);
  s.rec.assertIsolation(placed.length + refused.length === racers.length, `${racers.length - placed.length - refused.length} racers neither placed nor refused`, NO_TENANT);
  const after = await deploymentsOf(s);
  for (const t of refused) s.rec.assertIsolation(!after.has(t), 'a refused tenant has a deployment', t);
  await waitDeployments(s, placed, { timeoutSeconds: waveTimeout(placed.length, s.buildLimit) });
  await assertFleet(s, placed);
  await offboard(s, placed);
}

/**
 * Whether an UpdateTenant answer is a 409 a retry can clear. The control plane marks those
 * by `retry the request` in the message (R-14, `RETRY_HINT`, src/tenant/tenant.ts): the
 * tenant is still in flight (`CREATING` or `UPDATING`, usually from the scenario's last
 * write), or another write was accepted between this request's read and its own write
 * (`staleUpdateFailure`). Any other 409, such as the one for `CREATE_FAILED`, `DELETING` or
 * `DELETE_FAILED` (`updateConflict`), is a finding.
 */
const retryableConflict = (r: CallResult): boolean =>
  r.status === 409 && r.errorType === 'ConflictError' &&
  String(r.body?.message ?? '').includes('retry the request');

/**
 * Read rate under writes (spec §5.2): ListDeployments by tenant, GetDeployment and ListCells
 * at the tier's steady rate for the scenario length, while the churn tenants are placed and
 * each seeded tenant's record is updated. Every read is checked: a tenant's list holds only
 * that tenant's deployment, a GetDeployment names its tenant and a cell of the application,
 * and ListCells lists only the application's cells within their limit.
 */
export async function readRate(s: ScenarioEnv): Promise<void> {
  const known = await deploymentsOf(s);
  const cells = new Set((await cellsOf(s)).map((c) => c.cellId));
  const tenants = s.manifest.seeded.filter((t) => known.has(t));
  if (tenants.length === 0) {
    s.rec.finding('no seeded deployment to read: run PS-1 first');
    return;
  }
  const writes = Promise.all(s.manifest.churn.map((t) => placeDeployment(s, t, 'create-deployment-churn')));
  const end = Date.now() + s.tier.scenarioSeconds * 1000;
  const interval = 1000 / s.tier.steadyRps;
  let n = 0;
  const inflight: Promise<void>[] = [];
  const updates: Promise<CallResult>[] = [];
  let writeIndex = 0;
  while (Date.now() < end) {
    const i = n;
    n += 1;
    const t = tenants[i % tenants.length];
    inflight.push(
      (async () => {
        if (i % 3 === 0) {
          const r = await s.api.call('list-deployments-by-tenant', 'GET', `/deployments?tenantId=${enc(t)}`, t);
          if (r.status === 200) {
            const items = (r.body?.deployments ?? []) as DeploymentState[];
            s.rec.assertIsolation(items.every((d) => d.tenantId === t), 'ListDeployments by tenant listed another tenant', t);
            s.rec.assertIsolation(items.filter((d) => d.applicationId === s.applicationId).length <= 1, 'more than one deployment of the application', t);
          }
        } else if (i % 3 === 1) {
          const r = await s.api.call('get-deployment', 'GET', `/tenants/${enc(t)}/deployments/${enc(s.applicationId)}`, t);
          if (r.status === 200) {
            const d = r.body?.deployment as DeploymentState | undefined;
            s.rec.assertIsolation(d?.tenantId === t && d?.applicationId === s.applicationId, 'GetDeployment returned another deployment', t);
            s.rec.assertIsolation(d !== undefined && cells.has(d.cellId), 'GetDeployment names a cell outside the application', t);
          }
        } else {
          const r = await s.api.call('list-cells', 'GET', `/cells?applicationId=${enc(s.applicationId)}`, NO_TENANT);
          if (r.status === 200) {
            const items = (r.body?.cells ?? []) as CellState[];
            s.rec.assertIsolation(items.every((c) => c.applicationId === s.applicationId && c.tenantCount <= c.maxTenants), 'ListCells listed a foreign or overfull cell', NO_TENANT);
          }
        }
      })(),
    );
    // A record write every tenth tick: UpdateTenant runs the record event (no build). A
    // ConflictError (409) whose message says to retry the request (R-14) is expected, no
    // refusal; any other 409 is a finding below (retryableConflict).
    if (i % 10 === 0) {
      const w = tenants[writeIndex % tenants.length];
      writeIndex += 1;
      updates.push(s.api.call('update-tenant', 'PUT', `/tenants/${enc(w)}`, w, { description: `stress read-rate write ${writeIndex}` }, [409]));
    }
    await sleep(interval);
  }
  await Promise.all(inflight);
  const written = await Promise.all(updates);
  for (const r of written) if (!retryableConflict(r)) expectStatus(s, r, 202, 'UpdateTenant');
  const landed = written.filter((r) => r.status === 202).length;
  if (landed === 0) s.rec.finding(`no UpdateTenant write was accepted (${written.length} sent): the reads ran under no writes`);
  const results = await writes;
  const accepted = s.manifest.churn.filter((_, i) => results[i] === 'accepted' || results[i] === 'exists');
  s.log(`read rate: ${n} reads at ${s.tier.steadyRps} rps; ${landed} of ${written.length} tenant updates accepted; ${accepted.length} churn deployments placed`);
  await waitDeployments(s, accepted, { timeoutSeconds: waveTimeout(accepted.length, s.buildLimit) });
  await assertFleet(s, accepted);
  await offboard(s, accepted);
}

/**
 * Build-limit scaling (spec §5.2): the seeded deployments removed and onboarded again at
 * each build limit in 5, 20 and 50 that the deployed limit allows, timing the onboarding
 * wave (`wave-at-<limit>`) and each deployment (`onboard-at-<limit>`). The control plane
 * is redeployed with each limit and with the deployed one again at the end.
 */
export async function buildLimitScaling(s: ScenarioEnv): Promise<void> {
  const known = await deploymentsOf(s);
  const wave = s.manifest.seeded.filter((t) => known.get(t)?.status === 'ACTIVE');
  if (wave.length === 0) {
    s.rec.finding('no seeded deployment to scale with: run PS-1 first');
    return;
  }
  const limits = scalingLimitsFor(s.buildLimit);
  try {
    for (const limit of limits) {
      const seconds = await s.setBuildLimit(limit);
      s.rec.sample('set-build-limit', seconds);
      const at: ScenarioEnv = { ...s, buildLimit: limit };
      await offboard(at, wave);
      const r = await onboard(at, wave, `onboard-at-${limit}`);
      s.rec.sample(`wave-at-${limit}`, r.waveSeconds);
      s.log(`build limit ${limit}: ${r.placed.length} deployments in ${Math.round(r.waveSeconds)} s (${(r.placed.length / (r.waveSeconds / 60)).toFixed(1)} a minute)`);
      await assertFleet(s, wave);
    }
  } finally {
    // A failed restore is a finding; it must not replace the error that stopped the waves.
    if (limits.length > 0 && limits[limits.length - 1] !== s.buildLimit) {
      try {
        await s.setBuildLimit(s.buildLimit);
      } catch (e) {
        s.rec.finding(`restore of build limit ${s.buildLimit} failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }
}

export const SCENARIOS: Readonly<Record<string, (s: ScenarioEnv) => Promise<void>>> = {
  'PS-1': ps1,
  'PS-5': (s) => ps5(s),
  'placement-race': placementRace,
  'read-rate': readRate,
  'build-limit-scaling': buildLimitScaling,
};
