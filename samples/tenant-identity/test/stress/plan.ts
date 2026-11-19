// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the tenant-identity stress slice does at a tier (platform stress
 * test, docs/stress-test.spec.md §4.1, §4.4): the sizes of its tenant sets,
 * its draw on each account-wide quota, and the names it deploys under.
 * Pure: no AWS call, so `budget` can run without credentials.
 */

export type Mode = 'slice' | 'platform';

/** The part of the runner's `STRESS_TIER_JSON` this slice reads. */
export interface TierSizes {
  readonly name: string;
  readonly tenantsSeeded: number;
  readonly tenantsActive: number;
  readonly usersPerActiveTenant: number;
  readonly onboarding: 'every-run' | 'fixture';
  readonly churnPerRun: number;
  readonly steadyRps: number;
  readonly scenarioSeconds: number;
}

/** A Cognito user pool holds at most 10,000 groups and a tenant takes two. */
export const GROUPS_PER_TENANT = 2;

/** Tenants the slice seeds in `platform` mode: the control plane onboards the rest. */
export const PLATFORM_PROBE_TENANTS = 20;

/** Seeding and token preparation pace, under the platform API's 10 rps method throttle (ADR-0037). */
export const SEED_PACE_PER_SECOND = 4;
export const ISSUE_PACE_PER_SECOND = 8;

/** The onboarding batch runs this many tenants at once, at most (the control plane's build limit). */
export const MAX_ONBOARD_CONCURRENCY = 50;

/**
 * The burst is this many times the tier's churn count. At most
 * `MAX_BURST_CONCURRENCY` tenants are onboarded at once: each of those
 * workers runs one tenant's whole onboarding, so beyond 100 tenants the
 * CreateTenant calls start in waves, not in one instant (ADR-0042).
 */
export const BURST_FACTOR = 4;
export const MAX_BURST_CONCURRENCY = 100;

const STACK_SUFFIX = 'identity';
const PREFIX = /^[A-Za-z][A-Za-z0-9-]{2,40}$/;

/**
 * The stack name for a stress prefix. Refuses a prefix that could name one of
 * the integration tests' stacks (`TenantIdentity-<topology>`), so the stress
 * deployment can never be the long-lived shared pool.
 */
export function stackNameOf(prefix: string | undefined): string {
  if (prefix === undefined || !PREFIX.test(prefix)) {
    throw new Error(`STRESS_PREFIX must match ${PREFIX}`);
  }
  if (prefix.toLowerCase().startsWith('tenantidentity')) {
    throw new Error('STRESS_PREFIX must not start with TenantIdentity: those stacks belong to the integration tests');
  }
  return `${prefix}-${STACK_SUFFIX}`;
}

/** The one SSM parameter the slice publishes for the next slice (stress ADR-0002). */
export function parameterNameOf(prefix: string): string {
  stackNameOf(prefix);
  return `/${prefix}/${STACK_SUFFIX}`;
}

function count(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`STRESS_TIER_JSON.${field} must be a non-negative integer`);
  }
  return v;
}

function positive(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`STRESS_TIER_JSON.${field} must be a positive number`);
  }
  return v;
}

/** Reads the tier the runner passes in `STRESS_TIER_JSON`. */
export function parseTier(json: string | undefined): TierSizes {
  if (json === undefined || json === '') {
    throw new Error('STRESS_TIER_JSON is not set');
  }
  const doc = JSON.parse(json) as Record<string, unknown>;
  if (typeof doc.name !== 'string') {
    throw new Error('STRESS_TIER_JSON.name must be a string');
  }
  if (doc.onboarding !== 'every-run' && doc.onboarding !== 'fixture') {
    throw new Error('STRESS_TIER_JSON.onboarding must be every-run or fixture');
  }
  const tier: TierSizes = {
    name: doc.name,
    tenantsSeeded: count(doc.tenantsSeeded, 'tenantsSeeded'),
    tenantsActive: count(doc.tenantsActive, 'tenantsActive'),
    usersPerActiveTenant: count(doc.usersPerActiveTenant, 'usersPerActiveTenant'),
    onboarding: doc.onboarding,
    churnPerRun: count(doc.churnPerRun, 'churnPerRun'),
    steadyRps: positive(doc.steadyRps, 'steadyRps'),
    scenarioSeconds: count(doc.scenarioSeconds, 'scenarioSeconds'),
  };
  if (tier.tenantsActive > tier.tenantsSeeded) {
    throw new Error('STRESS_TIER_JSON: tenantsActive exceeds tenantsSeeded');
  }
  return tier;
}

export function parseMode(value: string | undefined): Mode {
  if (value !== 'slice' && value !== 'platform') {
    throw new Error(`STRESS_MODE must be slice or platform (got ${String(value)})`);
  }
  return value;
}

export interface Plan {
  readonly tier: TierSizes;
  readonly mode: Mode;
  /** Tenants `seed` creates (the slice's own steady set). */
  readonly seedTenants: number;
  /** The first of them that the rate scenario drives: they hold the extra users. */
  readonly activeTenants: number;
  /** Users beyond the first admin, per active tenant. */
  readonly extraUsers: number;
  /** PS-1: tenants onboarded, and how many at once. */
  readonly onboardTenants: number;
  readonly onboardConcurrency: number;
  /** create-tenant-burst: tenants created, at most `burstConcurrency` onboarding at once. */
  readonly burstTenants: number;
  readonly burstConcurrency: number;
  /** Tenants the control plane puts into the stress pool (`platform` mode only, else 0). */
  readonly controlPlaneTenants: number;
  /** The most tenants the stress pool holds at one moment, whoever created them. */
  readonly peakPoolTenants: number;
}

export function planOf(tier: TierSizes, mode: Mode): Plan {
  const seedTenants = mode === 'slice' ? tier.tenantsSeeded : Math.min(tier.tenantsSeeded, PLATFORM_PROBE_TENANTS);
  const onboardTenants = tier.churnPerRun;
  const burstTenants = tier.churnPerRun * BURST_FACTOR;
  // In `platform` mode the control plane puts the tier's tenants and its own
  // churn into the same pool, beside the slice's probe tenants.
  const others = mode === 'platform' ? tier.tenantsSeeded + tier.churnPerRun : 0;
  return {
    tier,
    mode,
    seedTenants,
    activeTenants: Math.min(seedTenants, tier.tenantsActive),
    extraUsers: Math.max(0, tier.usersPerActiveTenant - 1),
    onboardTenants,
    onboardConcurrency: Math.min(onboardTenants, MAX_ONBOARD_CONCURRENCY),
    burstTenants,
    burstConcurrency: Math.min(burstTenants, MAX_BURST_CONCURRENCY),
    controlPlaneTenants: others,
    peakPoolTenants: others + seedTenants + Math.max(onboardTenants, burstTenants),
  };
}

export interface Draw {
  readonly account: string;
  readonly quota: string;
  readonly amount: number;
}

/**
 * The slice's draw on each budgeted quota (spec §4.4, tenant-identity column).
 * Declared in `slice.json`: lambda-concurrency, cognito-groups,
 * cognito-user-authentication-rps. ADR-0042 gives the reasoning for each.
 */
export function drawsOf(plan: Plan): Draw[] {
  const { tier } = plan;
  return [
    {
      account: 'platform',
      quota: 'cognito-groups',
      amount: GROUPS_PER_TENANT * plan.peakPoolTenants,
    },
    {
      account: 'platform',
      quota: 'cognito-user-authentication-rps',
      // PS-1 and the burst do not pace their token calls: every onboarding
      // in flight can issue one token per user within the same second.
      amount: Math.max(
        tier.steadyRps,
        ISSUE_PACE_PER_SECOND,
        Math.max(plan.onboardConcurrency, plan.burstConcurrency) * tier.usersPerActiveTenant,
      ),
    },
    {
      account: 'platform',
      quota: 'lambda-concurrency',
      // A token call holds the token or platform function and the trigger
      // for about a second each; a burst holds one platform call per tenant.
      amount: Math.max(2 * tier.steadyRps, plan.burstConcurrency, 10),
    },
  ];
}
