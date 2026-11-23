// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane operations the stress scenarios and the slice's verbs share: placing and
 * removing deployments, waiting for them, and the isolation assertions on what a placement
 * made (P-1). Every call goes through `ControlPlaneApi`, so it lands in the scenario's
 * record; nothing here prints a value.
 */

import { randomUUID } from 'node:crypto';
import { type CallResult, ControlPlaneApi } from './api';
import { aws, sleep } from './aws';
import type { CellAccountInput } from './plan';
import { AMBIGUOUS_PLACEMENT, NO_TENANT, type Recorder } from './recorder';

export interface FleetEnv {
  readonly api: ControlPlaneApi;
  readonly rec: Recorder;
  readonly applicationId: string;
  readonly platformAccount: string;
  readonly cellAccounts: readonly CellAccountInput[];
  readonly region: string;
  readonly log: (line: string) => void;
}

export type Placement = 'accepted' | 'exists' | 'full' | 'failed';

const POLL_MS = 15_000;
const enc = encodeURIComponent;

/** A test address no mail ever reaches (SES mailbox simulator). */
export const adminEmailOf = (tenant: string): string => `success+${tenant.toLowerCase()}@simulator.amazonses.com`;

/**
 * One `CreateDeployment`, retried on a lost claim race (control-plane ADR-0031), an
 * ambiguous placement (a 500 the control plane answers when a placement transaction is
 * cancelled without a failed condition, such as a DynamoDB `TransactionConflict` between
 * concurrent claims on one cell: control-plane spec §7 never retargets it), a throttle or a
 * transport failure. Every attempt carries the same client token, so a retry after an
 * ambiguous outcome replays it instead of placing twice (stress ADR-0013). Returns
 * `accepted` (202), `exists` (the tenant has one), `full` (`InsufficientCapacityError`,
 * which never clears by waiting) or `failed`.
 */
export async function placeDeployment(f: FleetEnv, tenant: string, hop = 'create-deployment'): Promise<Placement> {
  const clientToken = randomUUID().replace(/-/g, '');
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const r = await f.api.call(hop, 'POST', `/tenants/${enc(tenant)}/deployments`, tenant, {
      applicationId: f.applicationId,
      adminEmail: adminEmailOf(tenant),
      clientToken,
    });
    if (r.status === 202) return 'accepted';
    if (r.errorType === 'InsufficientCapacityError') return 'full';
    if (r.status === 409 && /already/i.test(String(r.body?.message ?? ''))) return attempt === 1 ? 'exists' : 'accepted';
    const retryable =
      r.status === 0 ||
      r.status === 429 ||
      r.status === 503 ||
      (r.status === 409 && /claim race/i.test(String(r.body?.message ?? ''))) ||
      (r.status === 500 && AMBIGUOUS_PLACEMENT.test(String(r.body?.message ?? '')));
    if (!retryable) return 'failed';
    await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
  return 'failed';
}

/** `DeleteDeployment`; a deployment that is already gone counts as removed. */
export async function removeDeployment(f: FleetEnv, tenant: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const r = await f.api.call('delete-deployment', 'DELETE', `/tenants/${enc(tenant)}/deployments/${enc(f.applicationId)}`, tenant, undefined, [404]);
    if (r.status === 202 || r.status === 404) return true;
    // A 409 here is an in-flight operation on the deployment: wait for it.
    if (r.status !== 0 && r.status !== 409 && r.status !== 429 && r.status !== 503) return false;
    await sleep(r.status === 409 ? POLL_MS : 500 * 2 ** attempt);
  }
  return false;
}

export interface DeploymentState {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly cellId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusReason?: string;
  readonly accountId?: string;
}

/** Every deployment of the application, keyed by tenant (one `ListDeployments` walk). */
export async function deploymentsOf(f: FleetEnv): Promise<Map<string, DeploymentState>> {
  const { items, status } = await f.api.listAll('list-deployments', `/deployments?applicationId=${enc(f.applicationId)}&maxResults=100`, 'deployments');
  if (status !== 200) throw new Error(`ListDeployments answered HTTP ${status}`);
  return new Map(items.map((d) => [String(d.tenantId), d as DeploymentState]));
}

export interface CellState {
  readonly cellId: string;
  readonly applicationId: string;
  readonly accountId: string;
  readonly status: string;
  readonly maxTenants: number;
  readonly tenantCount: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export async function cellsOf(f: FleetEnv): Promise<CellState[]> {
  const { items, status } = await f.api.listAll('list-cells', `/cells?applicationId=${enc(f.applicationId)}&maxResults=100`, 'cells');
  if (status !== 200) throw new Error(`ListCells answered HTTP ${status}`);
  return items as CellState[];
}

const TERMINAL = /^(ACTIVE|[A-Z]+_FAILED)$/;

/**
 * Waits until every listed tenant's deployment is terminal (ACTIVE or *_FAILED), or until
 * `gone` is set and it no longer exists. Returns the last state of each (undefined: gone).
 */
export async function waitDeployments(
  f: FleetEnv,
  tenants: readonly string[],
  opts: { gone?: boolean; timeoutSeconds: number },
): Promise<Map<string, DeploymentState | undefined>> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let last = new Map<string, DeploymentState | undefined>();
  for (;;) {
    const all = await deploymentsOf(f);
    last = new Map(tenants.map((t) => [t, all.get(t)]));
    const pending = tenants.filter((t) => {
      const d = all.get(t);
      return opts.gone === true ? d !== undefined && !/_FAILED$/.test(d.status) : d === undefined || !TERMINAL.test(d.status);
    });
    if (pending.length === 0) return last;
    if (Date.now() > deadline) {
      f.rec.finding(`${pending.length} deployments not ${opts.gone === true ? 'removed' : 'terminal'} within ${opts.timeoutSeconds} s`);
      return last;
    }
    await sleep(POLL_MS);
  }
}

/** Seconds from a deployment's creation to its last write: CreateDeployment to ACTIVE. */
export function onboardSeconds(d: DeploymentState): number {
  return Math.max(0, (Date.parse(d.updatedAt) - Date.parse(d.createdAt)) / 1000);
}

/** The cell-account profile for an account id, when the account is one of the run's. */
const profileOf = (f: FleetEnv, account: string): string | undefined => f.cellAccounts.find((a) => a.accountId === account)?.profile;

/**
 * The isolation assertions on a set of ACTIVE deployments (P-1, spec §5.3 "cell"):
 *
 * 1. the deployment names its own tenant and the stress application;
 * 2. its cell is a cell of the stress application, in a registered cell account, never
 *    the platform account;
 * 3. the cell holds no more deployments than its `maxTenants`;
 * 4. in the cell's account, the tenant build's record names this tenant and this cell
 *    (the tenant script wrote it under the cell account's role pair).
 */
export async function assertPlaced(f: FleetEnv, deployments: readonly DeploymentState[], cells: readonly CellState[]): Promise<void> {
  const byId = new Map(cells.map((c) => [c.cellId, c]));
  const accounts = new Set(f.cellAccounts.map((a) => a.accountId));
  for (const c of cells) {
    f.rec.assertIsolation(c.applicationId === f.applicationId, `cell ${c.cellId} is of another application`, NO_TENANT);
    f.rec.assertIsolation(accounts.has(c.accountId) && c.accountId !== f.platformAccount, `cell ${c.cellId} is outside the cell accounts`, NO_TENANT);
    f.rec.assertIsolation(c.tenantCount <= c.maxTenants, `cell ${c.cellId} holds ${c.tenantCount} of ${c.maxTenants}`, NO_TENANT);
  }
  const byAccount = new Map<string, DeploymentState[]>();
  for (const d of deployments) {
    f.rec.assertIsolation(d.applicationId === f.applicationId, 'deployment of another application listed', d.tenantId);
    const cell = byId.get(d.cellId);
    f.rec.assertIsolation(cell !== undefined, `deployment placed in cell ${d.cellId}, not a cell of the application`, d.tenantId);
    if (cell === undefined) continue;
    byAccount.set(cell.accountId, [...(byAccount.get(cell.accountId) ?? []), d]);
  }
  for (const [account, list] of byAccount) {
    const profile = profileOf(f, account);
    if (profile === undefined) continue;
    for (let i = 0; i < list.length; i += 10) {
      const batch = list.slice(i, i + 10);
      const names = batch.map((d) => `/application-plane/tenants/${d.tenantId}/${f.applicationId}/state`);
      const out = await aws(['ssm', 'get-parameters', '--names', ...names], { profile, region: f.region });
      const values = new Map<string, string>((out.Parameters ?? []).map((p: any) => [String(p.Name), String(p.Value)]));
      for (const d of batch) {
        let state: any;
        try {
          state = JSON.parse(values.get(`/application-plane/tenants/${d.tenantId}/${f.applicationId}/state`) ?? 'null');
        } catch {
          state = null;
        }
        f.rec.assertIsolation(
          state !== null && state.tenantId === d.tenantId && state.cellId === d.cellId && state.applicationId === f.applicationId,
          `the tenant build's record in the cell account does not name this tenant and cell ${d.cellId}`,
          d.tenantId,
        );
      }
    }
  }
}

/** Whether a call answered as `expected`; a finding names the operation otherwise. */
export function expectStatus(f: FleetEnv, r: CallResult, expected: number, what: string): boolean {
  if (r.status === expected) return true;
  f.rec.finding(`${what}: HTTP ${r.status}${r.errorType === undefined ? '' : ` (${r.errorType})`}, expected ${expected}`);
  return false;
}

/**
 * A `*_FAILED` status the control plane gives when a workflow's terminal DynamoDB
 * transaction is cancelled by a concurrent one on the same cell (`TransactionConflict`); the
 * build itself succeeded. Another try of the operation succeeds (stress ADR-0013).
 */
export const CONFLICT_FAILURE = /TransactionCanceledException|TransactionConflict/;

/** How often a paced wave reads the deployments. */
const WAVE_POLL_MS = 10_000;

/**
 * Runs `start` for each tenant with at most `limit` operations in flight, an operation
 * being in flight until `settled` says its deployment is. The control plane's builds do
 * not queue past the concurrent build limit: CodeBuild refuses a `StartBuild` over it, and
 * the workflow fails the operation after its retries (control-plane finding, stress
 * ADR-0013). So the driver keeps every wave at the limit, as a client of the control plane
 * must. Returns the tenants `start` refused.
 */
export async function paced(
  f: FleetEnv,
  tenants: readonly string[],
  limit: number,
  timeoutSeconds: number,
  start: (tenant: string) => Promise<boolean>,
  settled: (d: DeploymentState | undefined) => boolean,
): Promise<string[]> {
  const queue = [...tenants];
  const inflight = new Set<string>();
  const refused: string[] = [];
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < limit && queue.length > 0) {
      const t = queue.shift()!;
      if (await start(t)) inflight.add(t);
      else refused.push(t);
    }
    // One operation runs one build at a time, so the operations in flight are the slice's
    // draw on the platform account's concurrent Linux/Small builds (spec §4.4).
    f.rec.quotaPeak('platform', 'codebuild-linux-small', inflight.size);
    if (inflight.size === 0) continue;
    if (Date.now() > deadline) {
      f.rec.finding(`${inflight.size + queue.length} operations not settled within ${timeoutSeconds} s`);
      break;
    }
    await sleep(WAVE_POLL_MS);
    const all = await deploymentsOf(f);
    for (const t of [...inflight]) if (settled(all.get(t))) inflight.delete(t);
  }
  return refused;
}

/**
 * Removes the tenants' deployments at most `limit` at a time and waits until they are
 * gone. A deployment that ends `DELETE_FAILED` on a transaction conflict (`CONFLICT_FAILURE`)
 * is deleted again, up to `rounds` times in all, each retry counted as
 * `DELETE_FAILED:retried`; any other `DELETE_FAILED` is a finding with its reason. Returns
 * the tenants whose deployment is still there.
 */
export async function removeAll(f: FleetEnv, tenants: readonly string[], limit: number, timeoutSeconds: number, rounds = 3): Promise<string[]> {
  let round = [...tenants];
  let stuck: string[] = [];
  for (let attempt = 1; attempt <= rounds && round.length > 0; attempt += 1) {
    if (attempt > 1) for (let i = 0; i < round.length; i += 1) f.rec.count('DELETE_FAILED:retried');
    const refused = await paced(f, round, limit, timeoutSeconds, (t) => removeDeployment(f, t), (d) => d === undefined || /_FAILED$/.test(d.status));
    if (refused.length > 0) f.rec.finding(`${refused.length} DeleteDeployment calls failed`);
    const all = await deploymentsOf(f);
    stuck = round.filter((t) => all.has(t));
    const retry = stuck.filter((t) => all.get(t)!.status === 'DELETE_FAILED' && CONFLICT_FAILURE.test(all.get(t)!.statusReason ?? ''));
    for (const t of stuck.filter((x) => !retry.includes(x))) {
      f.rec.finding(`tenant ${t}: deployment ${all.get(t)!.status} (${String(all.get(t)!.statusReason ?? 'no reason').slice(0, 160)})`);
    }
    round = retry;
  }
  return stuck;
}
