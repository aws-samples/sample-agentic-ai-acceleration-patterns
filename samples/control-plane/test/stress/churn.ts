// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * PS-5, churn under load (platform stress test, docs/stress-test.spec.md §5.1, §7): the tier's
 * churn count of tenants have a deployment created, their route suspended and resumed, and the
 * deployment deleted, and each change is timed from the call to the first edge response that
 * shows it. The tenant records are the ones `seed` made, and they stay. Deployment creates and
 * deletes go to the control plane; suspend and resume go to the front door's route registrar
 * (`UpdateTenantRouteStatus`). The choices are in `adr/0048-measure-tenant-churn-through-the-front-door-edge.md`.
 * The edge read is one request with an unsigned token naming the tenant (`edge.ts`).
 *
 * Hops in the record: `routable` (CreateDeployment to the first answer that left the router),
 * `suspended` (the registrar call to 503), `resumed` (the registrar call to the first answer that
 * left the router again) and `removed` (DeleteDeployment to 403). The pass criteria are the
 * spec's (§7, Churn): a removed tenant never reaches an origin, and time to routable and time to
 * removed are reported with p50 and p99. There is no limit on the times until a run has set a
 * baseline. A tenant that is suspended is also never served (front-door spec §3.3, step 6).
 */

import { sleep } from './aws';
import { asCall, type Edge, type EdgeState, edgeStateOf } from './edge';
import { deploymentsOf, placeDeployment, removeDeployment, waitDeployments } from './fleet';
import type { ScenarioEnv } from './scenarios';

export interface Timing {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Time between two edge reads of one tenant. */
  readonly pollMs: number;
  /** After the edge first shows a tenant suspended or removed, wait this long before asserting it holds. */
  readonly settleSeconds: number;
  /** Edge reads that assert a suspended or removed tenant stays refused. */
  readonly confirmations: number;
}

/**
 * Front-door spikes saw a route change first served 16 to 37 s after the write and the last
 * miss up to 65 s after it (`samples/tenant-front-door/design/spikes.md`, "Propagation"); the
 * front-door spec waits 90 s where every request must see a change (§4.2).
 */
export const REAL_TIMING: Timing = { now: Date.now, sleep, pollMs: 2000, settleSeconds: 90, confirmations: 3 };

/** A tenant build, the route hook, then the edge. */
const ROUTABLE_TIMEOUT_SECONDS = 900;
/** A route status write, then the edge. */
const STATUS_TIMEOUT_SECONDS = 300;
/** A tenant delete build, the route hook, then the edge. */
const REMOVED_TIMEOUT_SECONDS = 900;

/**
 * An answer PS-5 asks for: every state a tenant passes through in a cycle is wanted (the
 * router's 403 before the route and after its removal, its 503 while suspended, an origin's
 * answer while routed), so only an answer that tells nothing about the tenant or a 5xx from an
 * origin is an unexpected one.
 */
const expectedAtEdge = (status: number, state: EdgeState): boolean => state !== 'error' && (status < 500 || state === 'suspended');

class EdgeMisconfigured extends Error {}

export async function ps5(s: ScenarioEnv, timing: Timing = REAL_TIMING): Promise<void> {
  const edge = s.edge;
  if (edge === undefined) {
    s.rec.finding('PS-5 has no edge: the tenant-front-door manifest was not read');
    return;
  }
  const existing = await deploymentsOf(s);
  const wanted = s.manifest.churn.slice(0, s.tier.churnPerRun);
  if (wanted.length < s.tier.churnPerRun) {
    s.rec.finding(`churn tenants in the manifest: ${s.manifest.churn.length}, the tier churns ${s.tier.churnPerRun}: PS-5 runs short`);
  }
  const tenants = wanted.filter((t) => {
    if (!existing.has(t)) return true;
    s.rec.finding(`tenant ${t} already has a deployment: PS-5 times a create from nothing`);
    return false;
  });
  // Credentials load before the first timed call, so no `suspended` or `resumed` hop includes them.
  await edge.prepare?.();
  const queue = [...tenants];
  // Cycles in flight: the most builds that can run at once, an upper bound on the draw on the
  // platform account's concurrent builds (a cycle also waits on the edge, with no build running).
  let active = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    for (let tenant = queue.shift(); tenant !== undefined; tenant = queue.shift()) {
      active += 1;
      s.rec.quotaPeak('platform', 'codebuild-linux-small', active);
      try {
        if (await cycle(s, edge, tenant, timing)) completed += 1;
      } catch (e) {
        const cause = e instanceof EdgeMisconfigured ? e.message : `the churn cycle stopped (${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error'})`;
        s.rec.finding(`tenant ${tenant}: ${cause}`);
      } finally {
        active -= 1;
      }
    }
  };
  // The control plane's builds do not queue past the build limit (stress ADR-0013): the
  // workers never run more cycles at once than it allows.
  await Promise.all(Array.from({ length: Math.min(s.buildLimit, tenants.length) }, worker));
  s.log(`PS-5: ${completed} of ${tenants.length} churn tenants completed a deployment cycle`);
}

/** One edge read, recorded as a call of its own so a surprising answer is attributed to the tenant. */
async function read(s: ScenarioEnv, edge: Edge, tenant: string): Promise<EdgeState> {
  const started = process.hrtime.bigint();
  const answer = await edge.probe(tenant);
  const state = edgeStateOf(answer);
  s.rec.observe('edge-probe', asCall(answer.status, started), tenant, expectedAtEdge(answer.status, state));
  if (answer.status === 404) {
    throw new EdgeMisconfigured(
      'the edge answered 404 for /agents/<backend>/invocations: the front door has no agent ingress, the backend name is wrong, or edgeUrl\'s host is not the front door\'s appDomain',
    );
  }
  if (answer.router && answer.status === 401) {
    throw new EdgeMisconfigured('the router answered 401 for the probe token: the front door reads the tenant from a claim other than tenant_id (its tenantClaim)');
  }
  return state;
}

/** Seconds from `since` until the edge shows `want`, or undefined (a finding) at the timeout. */
async function waitFor(
  s: ScenarioEnv,
  edge: Edge,
  tenant: string,
  want: EdgeState,
  since: number,
  timeoutSeconds: number,
  timing: Timing,
): Promise<number | undefined> {
  const deadline = since + timeoutSeconds * 1000;
  for (;;) {
    const state = await read(s, edge, tenant);
    if (state === want) return (timing.now() - since) / 1000;
    if (timing.now() > deadline) {
      s.rec.finding(`tenant ${tenant}: the edge did not show ${want} within ${timeoutSeconds} s (last answer: ${state})`);
      return undefined;
    }
    await timing.sleep(timing.pollMs);
  }
}

/**
 * Once the edge shows a tenant refused, waits for every point of presence to catch up and then
 * reads it again: each read is one isolation assertion (P-1) that the tenant is still refused.
 */
async function hold(s: ScenarioEnv, edge: Edge, tenant: string, state: 'suspended' | 'unrouted', timing: Timing): Promise<void> {
  await timing.sleep(timing.settleSeconds * 1000);
  for (let i = 0; i < timing.confirmations; i += 1) {
    // No answer from the edge (a timeout, a dropped connection) says nothing about the tenant:
    // read again a few times before it counts, and then as a finding, never as a served tenant.
    let now = await read(s, edge, tenant);
    for (let retry = 0; now === 'error' && retry < 3; retry += 1) {
      await timing.sleep(timing.pollMs);
      now = await read(s, edge, tenant);
    }
    if (now === 'error') {
      s.rec.finding(`tenant ${tenant}: no answer from the edge when asserting the tenant is ${state === 'unrouted' ? 'removed' : 'suspended'}`);
    } else {
      const kind = state === 'unrouted' ? 'removed' : 'suspended';
      // P-1: the tenant is still refused at the router. A refusal of the other kind (a removed
      // tenant that reads suspended, a suspended one that reads unrouted) is no breach, but a
      // finding: the route table is not what the call left.
      s.rec.assertIsolation(now === 'unrouted' || now === 'suspended', `a ${kind} tenant was answered as ${now}, not refused at the router`, tenant);
      if (now !== state && (now === 'unrouted' || now === 'suspended')) s.rec.finding(`tenant ${tenant}: a ${kind} tenant read as ${now}`);
    }
    await timing.sleep(timing.pollMs);
  }
}

async function setRoute(s: ScenarioEnv, edge: Edge, tenant: string, status: 'active' | 'suspended'): Promise<boolean> {
  const started = process.hrtime.bigint();
  const answer = await edge.setStatus(tenant, status);
  s.rec.observe('update-route-status', asCall(answer, started), tenant, answer === 200);
  // A 5xx is already a finding of its own (`observe`); the rest names the call.
  if (answer !== 200 && answer < 500) {
    const hint = answer === 0 ? ' (no answer, or no credentials for the registrar: the session needs the edge operator role)' : '';
    s.rec.finding(`tenant ${tenant}: UpdateTenantRouteStatus ${status}: HTTP ${answer}, expected 200${hint}`);
  }
  return answer === 200;
}

async function cycle(s: ScenarioEnv, edge: Edge, tenant: string, timing: Timing): Promise<boolean> {
  const created = timing.now();
  const placed = await placeDeployment(s, tenant, 'create-deployment-churn');
  if (placed !== 'accepted') {
    s.rec.finding(`tenant ${tenant}: CreateDeployment ${placed}`);
    return false;
  }
  const routable = await waitFor(s, edge, tenant, 'routed', created, ROUTABLE_TIMEOUT_SECONDS, timing);
  if (routable === undefined) return false;
  s.rec.sample('routable', routable);

  const suspend = timing.now();
  if (!(await setRoute(s, edge, tenant, 'suspended'))) return false;
  const suspended = await waitFor(s, edge, tenant, 'suspended', suspend, STATUS_TIMEOUT_SECONDS, timing);
  if (suspended === undefined) return false;
  s.rec.sample('suspended', suspended);
  await hold(s, edge, tenant, 'suspended', timing);

  const resume = timing.now();
  if (!(await setRoute(s, edge, tenant, 'active'))) return false;
  const resumed = await waitFor(s, edge, tenant, 'routed', resume, STATUS_TIMEOUT_SECONDS, timing);
  if (resumed === undefined) return false;
  s.rec.sample('resumed', resumed);

  const removal = timing.now();
  if (!(await removeDeployment(s, tenant))) {
    s.rec.finding(`tenant ${tenant}: DeleteDeployment was refused`);
    return false;
  }
  const removed = await waitFor(s, edge, tenant, 'unrouted', removal, REMOVED_TIMEOUT_SECONDS, timing);
  if (removed === undefined) return false;
  s.rec.sample('removed', removed);
  await hold(s, edge, tenant, 'unrouted', timing);
  // The delete build ends after the route is gone: wait for it, so a successful cycle leaves the
  // fleet as the scenario found it. A cycle that stops early leaves its deployment for the sweep.
  await waitDeployments(s, [tenant], { gone: true, timeoutSeconds: REMOVED_TIMEOUT_SECONDS });
  return true;
}
