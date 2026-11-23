// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the front-door stress slice does at a tier: the sizes every scenario
 * reads and the quota draws `budget` prints. The runner hands the whole tier
 * over as JSON in `STRESS_TIER_JSON` (docs/stress-test.spec.md §3.4); this
 * file reads the fields it needs and nothing else, so the driver imports no
 * code from `stress/`. The unit test imports the contract's parsers to check
 * the records and the budget the driver writes.
 */

export interface TierJson {
  readonly name: 'small' | 'medium' | 'large';
  readonly tenantsSeeded: number;
  readonly tenantsActive: number;
  readonly onboarding: 'every-run' | 'fixture';
  readonly churnPerRun: number;
  readonly steadyRps: number;
  readonly peakRps: number;
  readonly scenarioSeconds: number;
}

export function parseTier(text: string | undefined): TierJson {
  if (text === undefined || text === '') throw new Error('STRESS_TIER_JSON is not set');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('STRESS_TIER_JSON is not JSON');
  }
  if (doc.name !== 'small' && doc.name !== 'medium' && doc.name !== 'large') throw new Error('STRESS_TIER_JSON: name must be small, medium or large');
  for (const f of ['tenantsSeeded', 'tenantsActive', 'churnPerRun', 'steadyRps', 'peakRps', 'scenarioSeconds']) {
    const v = doc[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`STRESS_TIER_JSON: ${f} must be a positive number`);
  }
  if (doc.onboarding !== 'every-run' && doc.onboarding !== 'fixture') throw new Error('STRESS_TIER_JSON: onboarding must be every-run or fixture');
  return doc as unknown as TierJson;
}

export interface Plan {
  /** Tenants with a route and a token for the load scenarios. */
  readonly activeTenants: number;
  /** Tenants with no route yet, written by `route-write`: the burst, then the sustained rate. */
  readonly writeBurst: number;
  readonly sustainedWritesPerSecond: number;
  readonly sustainedWriteSeconds: number;
  readonly sustainedWrites: number;
  /** Seconds a written route is watched: every request must see it by then (spec §4.2). */
  readonly routeWatchSeconds: number;
  /** `router-load`: seconds at the steady rate, then at the peak rate. */
  readonly steadySeconds: number;
  readonly peakSeconds: number;
  /** Share of `router-load` requests that carry a token padded close to the router's limit. */
  readonly largeTokenShare: number;
  /** `edge-refusals`: requests per refusal kind. */
  readonly refusalsPerKind: number;
  /** `PS-7`: rounds of every probe kind. */
  readonly probeRounds: number;
}

/**
 * Slice mode seeds at most `MAX_ACTIVE` identity tenants: the router reads at
 * most three keys per request however many tenants there are, and a
 * thousand CreateTenant calls would measure tenant-identity, not the front
 * door (the tenant-identity slice does that).
 */
export const MAX_ACTIVE = 100;

/** The tier's write burst is capped at the registrar stage's burst limit (`REGISTRAR_THROTTLE`, spec §3.4 step 5). */
export const MAX_BURST = 100;

/** The scenario's tokens carry a payload this long, in bytes of Authorization, below the router's 8,192-byte limit. */
export const LARGE_TOKEN_BYTES = 8000;

/** An Authorization header over the router's limit (spec §3.3 step 5). */
export const OVER_LIMIT_BYTES = 8300;

export function planOf(tier: TierJson): Plan {
  const sustainedWriteSeconds = Math.max(10, Math.round(Math.min(60, tier.scenarioSeconds / 2)));
  const sustainedWritesPerSecond = 1;
  return {
    activeTenants: Math.min(tier.tenantsActive, MAX_ACTIVE),
    writeBurst: Math.min(MAX_BURST, tier.tenantsSeeded),
    sustainedWritesPerSecond,
    sustainedWriteSeconds,
    sustainedWrites: sustainedWritesPerSecond * sustainedWriteSeconds,
    routeWatchSeconds: 90,
    steadySeconds: Math.round((tier.scenarioSeconds * 2) / 3),
    peakSeconds: Math.max(5, Math.round(tier.scenarioSeconds / 3)),
    largeTokenShare: 0.2,
    refusalsPerKind: Math.max(20, Math.round((tier.steadyRps * tier.scenarioSeconds) / 10)),
    probeRounds: tier.name === 'small' ? 10 : 25,
  };
}

/** Tenants the seed creates in tenant-identity: the active ones, the write pool and a few spare for refusal kinds. */
export function tenantsToSeed(plan: Plan): number {
  return plan.activeTenants + plan.writeBurst + plan.sustainedWrites + 1;
}

export interface Draw {
  readonly account: string;
  readonly quota: 'lambda-concurrency';
  readonly amount: number;
}

/**
 * The slice's draws on account-wide quotas (spec §4.4). Only Lambda
 * concurrency has a Service Quotas code in the shared catalogue: the
 * registrar and the demo cell are the functions the load reaches. CloudFront
 * Functions compute and the API Gateway control plane have no code in it
 * (README, known limitations), so the slice declares no draw on them.
 */
export function drawsOf(tier: TierJson): Draw[] {
  const plan = planOf(tier);
  // The registrar runs once per write in flight; the cell holds a request for about a quarter of a second at the peak.
  const registrar = plan.writeBurst;
  const cell = Math.ceil(tier.peakRps * 0.25);
  return [{ account: 'platform', quota: 'lambda-concurrency', amount: registrar + cell }];
}
