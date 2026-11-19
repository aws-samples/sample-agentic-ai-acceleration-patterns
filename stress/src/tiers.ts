// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The three tiers of the platform stress test (spec §4.1). Every slice reads
 * its sizes from here, so one tier means the same fleet in every sample.
 */

export const TIER_NAMES = ['small', 'medium', 'large'] as const;
export type TierName = (typeof TIER_NAMES)[number];

export interface Tier {
  readonly name: TierName;
  /** Standalone cell accounts (spec §3.7), beside the one platform account. */
  readonly cellAccounts: number;
  /** Cells across all cell accounts, spread evenly. */
  readonly cells: number;
  /** Deployments per cell: the seeded share plus the churn share (spec §4.1). */
  readonly maxTenants: number;
  readonly agentsPerCell: number;
  readonly toolTargetsPerCell: number;
  readonly toolsPerTarget: number;
  readonly tenantsSeeded: number;
  readonly tenantsActive: number;
  readonly usersPerActiveTenant: number;
  /** `fixture`: onboarded once and kept between runs (stress ADR-0004). */
  readonly onboarding: 'every-run' | 'fixture';
  readonly churnPerRun: number;
  readonly steadyRps: number;
  readonly peakRps: number;
  readonly scenarioSeconds: number;
  readonly driverInstanceType: string;
}

export const TIERS: Readonly<Record<TierName, Tier>> = {
  small: {
    name: 'small',
    cellAccounts: 1,
    cells: 1,
    maxTenants: 25,
    agentsPerCell: 2,
    toolTargetsPerCell: 2,
    toolsPerTarget: 10,
    tenantsSeeded: 20,
    tenantsActive: 20,
    usersPerActiveTenant: 2,
    onboarding: 'every-run',
    churnPerRun: 5,
    steadyRps: 10,
    peakRps: 40,
    scenarioSeconds: 60,
    driverInstanceType: 't3.large',
  },
  medium: {
    name: 'medium',
    cellAccounts: 2,
    cells: 2,
    maxTenants: 110,
    agentsPerCell: 5,
    toolTargetsPerCell: 2,
    toolsPerTarget: 100,
    tenantsSeeded: 200,
    tenantsActive: 200,
    usersPerActiveTenant: 2,
    onboarding: 'every-run',
    churnPerRun: 20,
    steadyRps: 100,
    peakRps: 300,
    scenarioSeconds: 180,
    driverInstanceType: 'c6i.xlarge',
  },
  large: {
    name: 'large',
    cellAccounts: 2,
    cells: 4,
    maxTenants: 1025,
    agentsPerCell: 25,
    toolTargetsPerCell: 3,
    toolsPerTarget: 100,
    tenantsSeeded: 4000,
    tenantsActive: 1000,
    usersPerActiveTenant: 1,
    onboarding: 'fixture',
    churnPerRun: 100,
    steadyRps: 500,
    peakRps: 1000,
    scenarioSeconds: 600,
    driverInstanceType: 'c6i.4xlarge',
  },
};

/** The tier named `name`; throws naming the tiers there are. */
export function tierOf(name: string | undefined): Tier {
  if (name === undefined || !(TIER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`STRESS_TIER must be one of ${TIER_NAMES.join(', ')} (got ${String(name)})`);
  }
  return TIERS[name as TierName];
}

/** The rules a tier must keep; one message per broken rule, none when it holds. */
export function tierProblems(t: Tier): string[] {
  const problems: string[] = [];
  if (t.cells * t.maxTenants !== t.tenantsSeeded + t.churnPerRun) {
    problems.push(`${t.name}: cells x maxTenants (${t.cells * t.maxTenants}) must equal tenantsSeeded + churnPerRun (${t.tenantsSeeded + t.churnPerRun})`);
  }
  if (t.cells % t.cellAccounts !== 0) {
    problems.push(`${t.name}: ${t.cells} cells do not spread evenly over ${t.cellAccounts} cell accounts`);
  }
  if (t.tenantsActive > t.tenantsSeeded) {
    problems.push(`${t.name}: tenantsActive (${t.tenantsActive}) exceeds tenantsSeeded (${t.tenantsSeeded})`);
  }
  if (t.peakRps < t.steadyRps) {
    problems.push(`${t.name}: peakRps (${t.peakRps}) is below steadyRps (${t.steadyRps})`);
  }
  // Two Cognito groups per tenant against a pool's 10,000 (stress ADR-0002).
  if (t.tenantsSeeded + t.churnPerRun > 5000) {
    problems.push(`${t.name}: more than 5,000 tenants do not fit one tenant-identity pool`);
  }
  return problems;
}
