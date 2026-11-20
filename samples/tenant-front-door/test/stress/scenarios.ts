// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { RequestKind } from './classify';
import { forgeToken, newUlid, payloadOf, registrarCause, retrying, unsignedToken, type IdentityClient, type Registrar } from './clients';
import { request, sleep } from './http';
import { paced, pool, shuffled } from './load';
import { LARGE_TOKEN_BYTES, OVER_LIMIT_BYTES, planOf } from './plan';
import { Recorder, type RecorderIdentity, type ResultRecordJson } from './recorder';
import { Sink, type Probe } from './sink';
import type { Env, Manifest, Outputs, RequestLine, TenantEntry } from './state';

/**
 * The four scenarios of the front-door slice (docs/stress-test.spec.md §5.2,
 * §5.1 PS-7). Each returns its result record and the request lines the join
 * with the edge log reads; none sends a token, a password or a key anywhere
 * but to the edge or the platform API it belongs to.
 */

export const SCENARIOS = ['PS-7', 'route-write', 'router-load', 'edge-refusals'] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface Ctx {
  readonly env: Env;
  readonly out: Outputs;
  readonly manifest: Manifest;
  readonly identity: IdentityClient;
  readonly registrar: Registrar;
}

export interface Outcome {
  readonly record: ResultRecordJson;
  readonly lines: readonly RequestLine[];
  /** Pass criteria the scenario broke; the verb exits non-zero when there are any. */
  readonly failures: readonly string[];
  /** What the scenario measured, one line each, for the run log. */
  readonly notes: readonly string[];
}

const TOKEN_ISSUE_CONCURRENCY = 8;
/** A registrar answer worth trying again: the route table was busy, or no answer. */
const busy = (r: { status: number }): boolean => r.status === 503 || r.status === 0;
/** Quiet time after the last answer: the next scenario's window never touches this one's (collect counts by window). */
const QUIET_MS = 5000;

const identityOf = (ctx: Ctx): RecorderIdentity => ({ runId: ctx.env.runId, tier: ctx.env.tier.name, mode: ctx.env.mode, commit: ctx.env.commit });

const active = (ctx: Ctx): TenantEntry[] => ctx.manifest.tenants.filter((t) => t.kind === 'active');
const writePool = (ctx: Ctx): TenantEntry[] => ctx.manifest.tenants.filter((t) => t.kind === 'write');

/** Tokens live five minutes (tenant-identity's access token); a scenario that runs longer issues new ones before these expire. */
const TOKEN_REFRESH_MS = 200_000;

/**
 * An access token per tenant. Held in memory for the scenario, never written down. The map is
 * refreshed in the background every `TOKEN_REFRESH_MS`, so a scenario of any length reads live
 * tokens; the timer does not keep the process alive, and one scenario runs per process.
 */
async function tokensFor(ctx: Ctx, tenants: readonly TenantEntry[]): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const issue = (): Promise<void> => pool(tenants, TOKEN_ISSUE_CONCURRENCY, async (t) => {
    tokens.set(t.tenantId, await ctx.identity.issueToken(t.tenantId, t.username));
  });
  await issue();
  const first = tokens.values().next().value;
  if (first !== undefined) {
    const p = payloadOf(first);
    console.log(`tokens: ${tokens.size} issued, lifetime ${Number(p.exp) - Number(p.iat)} s, refreshed every ${TOKEN_REFRESH_MS / 1000} s`);
  }
  // A refresh that fails is tried again after 20 s, well before the tokens it replaces (five minutes) run out.
  const refresh = (): void => {
    issue().then(
      () => { setTimeout(refresh, TOKEN_REFRESH_MS).unref(); },
      (e: unknown) => {
        console.error(`tokens: refresh failed (${e instanceof Error ? e.message : String(e)}); trying again in 20 s, the tokens in hand had about ${300 - TOKEN_REFRESH_MS / 1000} s left when this refresh began`);
        setTimeout(refresh, 20_000).unref();
      },
    );
  };
  setTimeout(refresh, TOKEN_REFRESH_MS).unref();
  return tokens;
}

const token = (tokens: ReadonlyMap<string, string>, tenantId: string): string => {
  const t = tokens.get(tenantId);
  if (t === undefined) throw new Error(`no token for ${tenantId}`);
  return t;
};

const bearer = (t: string): string => `Bearer ${t}`;

/** Sends one request to the edge and hands the answer to the sink. Never rejects. */
interface SendOptions {
  readonly path?: string;
  readonly auth?: string;
  readonly headers?: Record<string, string>;
  readonly url?: string;
}

async function send(ctx: Ctx, sink: Sink, p: Probe, o: SendOptions = {}): Promise<void> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.auth !== undefined) headers.authorization = o.auth;
  const r = await request({ method: 'GET', url: o.url ?? `https://${ctx.out.appDomain}${o.path ?? '/api/whoami'}`, headers });
  sink.take(p, r);
}

const whoami = (tenantId: string): Probe => ({ kind: 'whoami', tenant: tenantId, edgeTenant: tenantId.toLowerCase(), expect: tenantId });

// ---------------------------------------------------------------------------
// PS-7: probes at the router
// ---------------------------------------------------------------------------

/**
 * Cross-tenant probes at the router (spec §5.1 PS-7, router steps 1 and 5): a
 * token whose payload names another tenant, a route header and a token
 * header the client supplies, a token with a tenants list, a claim with no
 * route, and a direct call to the cell origin. Every probe is an assertion:
 * served is a mismatch. A plain request is the control.
 */
export async function ps7(ctx: Ctx): Promise<Outcome> {
  const plan = planOf(ctx.env.tier);
  const tenants = active(ctx);
  if (tenants.length < 2) throw new Error('PS-7 needs two active tenants');
  const tokens = await tokensFor(ctx, tenants);
  const rec = new Recorder();
  const sink = new Sink(rec);
  const jobs: (() => Promise<void>)[] = [];
  for (let round = 0; round < plan.probeRounds; round += 1) {
    const [a, b] = shuffled(tenants);
    const ta = token(tokens, a.tenantId);
    const tb = token(tokens, b.tenantId);
    const lowerB = b.tenantId.toLowerCase();
    jobs.push(
      () => send(ctx, sink, whoami(a.tenantId), { auth: bearer(ta) }),
      () => send(ctx, sink, { kind: 'forged-payload', tenant: b.tenantId, edgeTenant: lowerB }, { auth: bearer(forgeToken(ta, b.tenantId)) }),
      () => send(ctx, sink, { kind: 'client-route-header', tenant: a.tenantId, edgeTenant: a.tenantId.toLowerCase(), expect: a.tenantId }, { auth: bearer(ta), headers: { 'x-tenant-route': lowerB } }),
      () => send(ctx, sink, { kind: 'client-token-header', tenant: a.tenantId, edgeTenant: a.tenantId.toLowerCase(), expect: a.tenantId }, { auth: bearer(ta), headers: { 'x-tenant-token': tb } }),
      () => send(ctx, sink, { kind: 'tenants-list', tenant: '-', edgeTenant: '-' }, { auth: bearer(forgeToken(ta, a.tenantId, undefined, { tenants: [a.tenantId, b.tenantId] })) }),
      () => {
        const ghost = newUlid();
        return send(ctx, sink, { kind: 'unrouted', tenant: ghost, edgeTenant: ghost.toLowerCase() }, { auth: bearer(unsignedToken(ghost)) });
      },
      () => send(ctx, sink, { kind: 'direct-origin', tenant: a.tenantId }, { url: `${ctx.out.cellFunctionUrl}api/whoami`, headers: { 'x-tenant-token': ta, 'x-tenant-route': a.tenantId.toLowerCase() } }),
    );
  }
  await paced(10, jobs.length / 10, async (i) => jobs[i]());
  sink.flush();
  await sleep(QUIET_MS);
  return { record: rec.build(identityOf(ctx), 'PS-7'), lines: sink.lines, failures: rec.failures, notes: [`${jobs.length} probes in ${plan.probeRounds} rounds`] };
}

// ---------------------------------------------------------------------------
// route-write: route write rate and time to edge
// ---------------------------------------------------------------------------

/** What a registrar answer to a write means for the driver. */
export interface WriteAnswer {
  readonly written: boolean;
  /** Worth another attempt: the route table was busy. */
  readonly retry: boolean;
  /** For a refusal: the reason it is counted under; empty for a write. */
  readonly reason: string;
  /** A refusal the registrar is not documented to give a hook-role write; the scenario fails. */
  readonly violation?: string;
}

export function writeAnswer(r: { status: number; body: string }): WriteAnswer {
  if (r.status === 200) return { written: true, retry: false, reason: '' };
  if (r.status === 503) return { written: false, retry: true, reason: `registrar-${registrarCause(r)}` };
  return {
    written: false,
    retry: false,
    reason: `registrar-${r.status === 0 ? 'network' : 'refused'}`,
    violation: `route-write: the registrar answered a write with ${r.status === 0 ? 'no answer (network)' : `HTTP ${r.status}`}`,
  };
}

export interface Watch {
  readonly tenantId: string;
  firstRoutable?: number;
  lastMiss?: number;
  flaps: number;
  finalMisses: number;
}

/**
 * After a write, requests for the tenant every second: the answers give time to routable and the last miss.
 * `tokenOf` is read on every request, so a refreshed token is used.
 */
export async function watchRoute(ctx: Ctx, sink: Sink, w: Watch, tokenOf: () => string, seconds: number): Promise<void> {
  const from = Date.now();
  const until = from + seconds * 1000;
  let seenRoutable = false;
  while (Date.now() < until) {
    const tick = Date.now();
    const r = await request({ method: 'GET', url: `https://${ctx.out.appDomain}/api/whoami`, headers: { authorization: bearer(tokenOf()) } });
    const at = (Date.now() - from) / 1000;
    sink.take({ kind: 'route-watch', tenant: w.tenantId, edgeTenant: w.tenantId.toLowerCase(), expect: w.tenantId }, r);
    if (r.status === 200) {
      w.firstRoutable ??= at;
      seenRoutable = true;
    } else {
      w.lastMiss = at;
      if (seenRoutable) w.flaps += 1;
    }
    await sleep(Math.max(0, 1000 - (Date.now() - tick)));
  }
  // Ninety seconds on, every request must see the route (spec §3.4 step 5): ten more, a quarter second apart.
  for (let i = 0; i < 10; i += 1) {
    const r = await request({ method: 'GET', url: `https://${ctx.out.appDomain}/api/whoami`, headers: { authorization: bearer(tokenOf()) } });
    sink.take({ kind: 'route-watch', tenant: w.tenantId, edgeTenant: w.tenantId.toLowerCase(), expect: w.tenantId }, r);
    if (r.status !== 200) w.finalMisses += 1;
    await sleep(250);
  }
}

/**
 * Route write rate and time to edge (spec §3.4 step 5, §5.2): a burst of
 * `writeBurst` writes at once, then `sustainedWritesPerSecond` for
 * `sustainedWriteSeconds`, each a hook-role `PutTenantRoute` against the
 * registrar, which reads the stand-in control plane and writes the route
 * table with the store's ETag. Each written tenant is then watched for the
 * route (p50 and p99 of the write cycle and of the time to routable; no pass
 * limit until measured). A 503 is counted by cause; a failed write is tried
 * again as the hook does, four more times.
 */
export async function routeWrite(ctx: Ctx): Promise<Outcome> {
  const plan = planOf(ctx.env.tier);
  const pool0 = writePool(ctx).slice(0, plan.writeBurst + plan.sustainedWrites);
  if (pool0.length < plan.writeBurst + plan.sustainedWrites) throw new Error(`route-write needs ${plan.writeBurst + plan.sustainedWrites} seeded write tenants, the manifest has ${pool0.length}`);
  const burst = pool0.slice(0, plan.writeBurst);
  const sustained = pool0.slice(plan.writeBurst);
  const tokens = await tokensFor(ctx, pool0);
  const rec = new Recorder();
  const sink = new Sink(rec);
  const watches: Watch[] = [];
  const watching: Promise<void>[] = [];
  let failedWrites = 0;
  let attempts = 0;

  const write = async (t: TenantEntry): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      attempts += 1;
      const r = await ctx.registrar.putTenant(t.tenantId);
      const a = writeAnswer(r);
      if (a.written) {
        rec.tally('200:registrar-write');
        rec.hop('registrar-write', r.total);
        const w: Watch = { tenantId: t.tenantId, flaps: 0, finalMisses: 0 };
        watches.push(w);
        // A watch that throws (no token, say) is a finding of the scenario, not an unhandled rejection.
        watching.push(
          watchRoute(ctx, sink, w, () => token(tokens, t.tenantId), plan.routeWatchSeconds).catch((e: unknown) => {
            sink.violate(`route-write: a watch stopped: ${e instanceof Error ? e.message : String(e)}`);
          }),
        );
        return;
      }
      rec.request(r.status === 0 ? 599 : r.status, { tenant: t.tenantId, reason: a.reason });
      rec.hop('registrar-write-failed', r.total);
      if (a.violation !== undefined) sink.violate(a.violation);
      if (!a.retry) break;
      // Wait before the next attempt, not after the last one: a given-up write must not add its wait to the burst's time.
      if (attempt < 4) await sleep(5000 * (0.5 + Math.random()));
    }
    // A 503 after the driver's five attempts is counted, by cause, and does not fail the run: the hook retries it and the spec sets no limit before it is measured.
    failedWrites += 1;
  };

  await Promise.all(burst.map(write));
  const burstDone = Date.now();
  await paced(plan.sustainedWritesPerSecond, plan.sustainedWriteSeconds, async (i) => write(sustained[i]));
  await Promise.all(watching);

  for (const w of watches) {
    if (w.firstRoutable === undefined) {
      sink.violate('route-write: a written route never reached the edge in the watch window');
      continue;
    }
    rec.hop('time-to-routable', w.firstRoutable);
    rec.hop('time-to-last-miss', w.lastMiss ?? 0);
    if (w.finalMisses > 0) sink.violate(`route-write: a request after ${plan.routeWatchSeconds} s did not see the route`);
  }
  sink.flush();
  await sleep(QUIET_MS);
  const flapping = watches.filter((w) => w.flaps > 0);
  const refused503 = rec.entries().filter(([k]) => k.startsWith('503:registrar-')).map(([k, n]) => `${k}=${n}`);
  return {
    record: rec.build(identityOf(ctx), 'route-write'),
    lines: sink.lines,
    failures: rec.failures,
    notes: [
      `writes: burst ${burst.length} at once, then ${sustained.length} at ${plan.sustainedWritesPerSecond}/s; ${attempts} registrar calls, ${failedWrites} writes failed after five attempts`,
      `the burst's ${burst.length} writes were all written (or given up) ${Math.round((burstDone - rec.started.getTime()) / 1000)} s after it started, the driver's own waits before a retry included`,
      `a route served once and refused again before it settled (edge locations learn a write at different times): ${flapping.length} of ${watches.length} routes, ${flapping.reduce((a, w) => a + w.flaps, 0)} requests`,
      `registrar 503 by cause: ${refused503.length === 0 ? 'none' : refused503.join(' ')}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// router-load: router compute with large tokens
// ---------------------------------------------------------------------------

/**
 * Steady load at the tier's steady rate then at its peak rate through the
 * edge, over every active tenant. A share of the requests carries a token
 * padded to about `LARGE_TOKEN_BYTES` of Authorization: the router decodes
 * its payload (the work the router's compute is spent on) and the cell
 * refuses it, its signature being wrong. `collect` reads the router's
 * compute utilization for the window.
 */
export async function routerLoad(ctx: Ctx): Promise<Outcome> {
  const plan = planOf(ctx.env.tier);
  const tenants = active(ctx);
  const tokens = await tokensFor(ctx, tenants);
  // A padded token per live token: built once, again only when the token is refreshed.
  const padded = new Map<string, string>();
  const large = (tenantId: string): string => {
    const live = token(tokens, tenantId);
    let p = padded.get(live);
    if (p === undefined) {
      p = forgeToken(live, tenantId, LARGE_TOKEN_BYTES);
      padded.set(live, p);
    }
    return p;
  };
  const rec = new Recorder();
  const sink = new Sink(rec);
  const one = (i: number): Promise<void> => {
    const t = tenants[i % tenants.length];
    if (Math.random() < plan.largeTokenShare) {
      return send(ctx, sink, { kind: 'large-token', tenant: t.tenantId, edgeTenant: t.tenantId.toLowerCase() }, { auth: bearer(large(t.tenantId)) });
    }
    return send(ctx, sink, whoami(t.tenantId), { auth: bearer(token(tokens, t.tenantId)) });
  };
  const steady = await paced(ctx.env.tier.steadyRps, plan.steadySeconds, one);
  const peak = await paced(ctx.env.tier.peakRps, plan.peakSeconds, one);
  sink.flush();
  const late = steady.late + peak.late;
  if (late > 0) rec.problem(`router-load: the pacer started ${late} requests more than a second late; the driver host, not the edge, was the limit`);
  await sleep(QUIET_MS);
  return {
    record: rec.build(identityOf(ctx), 'router-load'),
    lines: sink.lines,
    failures: rec.failures,
    notes: [`${steady.started} requests at ${ctx.env.tier.steadyRps}/s, then ${peak.started} at ${ctx.env.tier.peakRps}/s; ${Math.round(plan.largeTokenShare * 100)} % with a token of about ${LARGE_TOKEN_BYTES} bytes`],
  };
}

// ---------------------------------------------------------------------------
// edge-refusals: refusals that never reach an origin
// ---------------------------------------------------------------------------

/** Polls the edge until a request for the tenant answers `want`, for up to `seconds`. */
async function waitFor(ctx: Ctx, t: string, want: number, seconds: number): Promise<number> {
  const from = Date.now();
  let run = 0;
  while (Date.now() - from < seconds * 1000) {
    const r = await request({ method: 'GET', url: `https://${ctx.out.appDomain}/api/whoami`, headers: { authorization: bearer(t) } });
    run = r.status === want ? run + 1 : 0;
    if (run >= 5) return (Date.now() - from) / 1000;
    await sleep(1000);
  }
  throw new Error(`the edge never answered ${want} five times in a row within ${seconds} s`);
}

/**
 * Refusals the router makes with no origin call (spec §5.2): no token, an
 * undecodable token, a tenant with no route, a suspended tenant, a
 * cross-site call, an Authorization over 8,192 bytes, and `/agents`. The
 * suspended tenant is the seeded spare, routed and then suspended with the
 * edge operator role (its time to 503 is reported). `collect` checks that
 * the cell's log holds no line for the scenario's window.
 */
export async function edgeRefusals(ctx: Ctx): Promise<Outcome> {
  const plan = planOf(ctx.env.tier);
  const tenants = active(ctx);
  const spare = writePool(ctx).at(-1);
  if (spare === undefined) throw new Error('edge-refusals needs the seeded spare tenant');
  const tokens = await tokensFor(ctx, [...tenants.slice(0, 1), spare]);
  const live = tenants[0];
  const notes: string[] = [];

  // The spare: routed, then suspended; the refusal kind needs the suspension to be live at the edge.
  const put = await retrying(() => ctx.registrar.putTenant(spare.tenantId), busy);
  if (put.status !== 200) throw new Error(`PutTenantRoute for the spare tenant: HTTP ${put.status}`);
  await waitFor(ctx, token(tokens, spare.tenantId), 200, 150);
  const s0 = Date.now();
  const suspend = await retrying(() => ctx.registrar.setStatus(spare.tenantId, 'suspended'), busy);
  if (suspend.status !== 200) throw new Error(`UpdateTenantRouteStatus: HTTP ${suspend.status}`);
  const toSuspended = await waitFor(ctx, token(tokens, spare.tenantId), 503, 150);
  notes.push(`time from the suspend call to five 503s in a row: ${Math.round((Date.now() - s0) / 100) / 10} s (the first of them ${Math.round(toSuspended * 10) / 10} s into the wait)`);

  const rec = new Recorder();
  const sink = new Sink(rec);
  const kinds: (() => Promise<void>)[] = [];
  const n = plan.refusalsPerKind;
  for (let i = 0; i < n; i += 1) {
    kinds.push(
      () => send(ctx, sink, { kind: 'no-token', tenant: '-', edgeTenant: '-' }),
      () => send(ctx, sink, { kind: 'bad-token', tenant: '-', edgeTenant: '-' }, { auth: 'Bearer abc.def.ghi' }),
      () => {
        const ghost = newUlid();
        return send(ctx, sink, { kind: 'unrouted', tenant: ghost, edgeTenant: ghost.toLowerCase() }, { auth: bearer(unsignedToken(ghost)) });
      },
      () => send(ctx, sink, { kind: 'suspended', tenant: spare.tenantId, edgeTenant: spare.tenantId.toLowerCase() }, { auth: bearer(token(tokens, spare.tenantId)) }),
      () => send(ctx, sink, { kind: 'cross-site', tenant: live.tenantId }, { auth: bearer(token(tokens, live.tenantId)), headers: { 'sec-fetch-site': 'same-site' } }),
      () => send(ctx, sink, { kind: 'token-too-long', tenant: '-', edgeTenant: '-' }, { auth: bearer(forgeToken(token(tokens, live.tenantId), live.tenantId, OVER_LIMIT_BYTES)) }),
      () => send(ctx, sink, { kind: 'agents-closed', tenant: '-' }, { path: '/agents/probe/invocations' }),
    );
  }
  const order = shuffled(kinds);
  await paced(ctx.env.tier.steadyRps, order.length / ctx.env.tier.steadyRps, async (i) => order[i]());
  sink.flush();
  const resume = await retrying(() => ctx.registrar.setStatus(spare.tenantId, 'active'), busy);
  if (resume.status !== 200) rec.problem(`the spare tenant could not be resumed: HTTP ${resume.status}`);
  await sleep(QUIET_MS);
  return { record: rec.build(identityOf(ctx), 'edge-refusals'), lines: sink.lines, failures: rec.failures, notes: [...notes, `${kinds.length} requests of ${new Set(sink.lines.map((l) => l.kind)).size} kinds`] };
}

export async function runScenario(ctx: Ctx, id: ScenarioId): Promise<Outcome> {
  switch (id) {
    case 'PS-7': return ps7(ctx);
    case 'route-write': return routeWrite(ctx);
    case 'router-load': return routerLoad(ctx);
    case 'edge-refusals': return edgeRefusals(ctx);
  }
}
