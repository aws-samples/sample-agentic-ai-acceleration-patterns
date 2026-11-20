// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's scenarios (platform stress test, docs/stress-test.spec.md §5.1
 * PS-1 and §5.2): onboarding (its share of PS-1, and the cell build time of spec Q-1),
 * placement races on a nearly full fleet, the read rate under writes, and onboarding rate at
 * build limits 5, 20 and 50. Every scenario makes isolation assertions (P-1) and leaves the
 * fleet as it found it, apart from PS-1, which onboards the seeded tenants for the rest.
 */

import type { CallResult } from './api';
import { sleep } from './aws';
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
import type { Manifest } from './manifest';
import { scalingLimitsFor, type TierSizes } from './plan';
import { NO_TENANT } from './recorder';

export interface ScenarioEnv extends FleetEnv {
  readonly tier: TierSizes;
  readonly manifest: Manifest;
  readonly buildLimit: number;
  /** Redeploys the control plane with another concurrent build limit (slice.sh set-build-limit). */
  readonly setBuildLimit: (limit: number) => Promise<number>;
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

/**
 * PS-1 onboarding (spec §5.1), the control plane's share: the seeded tenants onboarded at
 * the build limit. Hops: `create-deployment` (the API call), `onboard` (CreateDeployment to
 * ACTIVE, from the record's own timestamps), `cell-create` (a new cell's CREATING to ACTIVE,
 * spec Q-1) and `wave` (the whole batch). At a fixture tier whose seeded fleet is already
 * there, the churn tenants are onboarded and removed instead (spec §5.1).
 */
export async function ps1(s: ScenarioEnv): Promise<void> {
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
    // ConflictError (409) is the tenant still UPDATING from its last write: expected, no refusal.
    if (i % 10 === 0) {
      const w = tenants[writeIndex % tenants.length];
      writeIndex += 1;
      updates.push(s.api.call('update-tenant', 'PUT', `/tenants/${enc(w)}`, w, { description: `stress read-rate write ${writeIndex}` }, [409]));
    }
    await sleep(interval);
  }
  await Promise.all(inflight);
  const written = await Promise.all(updates);
  for (const r of written) {
    if (!(r.status === 409 && r.errorType === 'ConflictError')) expectStatus(s, r, 202, 'UpdateTenant');
  }
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
  'placement-race': placementRace,
  'read-rate': readRate,
  'build-limit-scaling': buildLimitScaling,
};
