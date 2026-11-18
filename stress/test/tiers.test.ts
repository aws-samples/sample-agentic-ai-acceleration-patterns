// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { cellAccountOf, TIER_NAMES, TIERS, tierOf, tierProblems } from '../src/tiers';

describe('tiers (spec §4.1)', () => {
  it.each(TIER_NAMES)('%s keeps every tier rule', (name) => {
    expect(tierProblems(TIERS[name])).toEqual([]);
  });

  it('leaves each cell its churn share on top of its seeded share', () => {
    for (const t of Object.values(TIERS)) {
      expect(t.cells * t.maxTenants - t.tenantsSeeded).toBe(t.churnPerRun);
    }
  });

  it('seeds large once, as a fixture, and the smaller tiers every run (stress ADR-0004)', () => {
    expect(TIERS.large.onboarding).toBe('fixture');
    expect(TIERS.small.onboarding).toBe('every-run');
    expect(TIERS.medium.onboarding).toBe('every-run');
  });

  it('keeps the runtime-isolation large tier at 100 agents in total (stress ADR-0003)', () => {
    expect(TIERS.large.cells * TIERS.large.agentsPerCell).toBe(100);
  });

  it('names the tiers there are on an unknown name', () => {
    expect(() => tierOf('huge')).toThrow(/small, medium, large/);
    expect(() => tierOf(undefined)).toThrow(/STRESS_TIER/);
    expect(tierOf('medium').cells).toBe(2);
  });

  it('reports each broken rule', () => {
    const broken = { ...TIERS.small, maxTenants: 20, cellAccounts: 2, tenantsActive: 7000, peakRps: 1, tenantsSeeded: 6000 };
    const problems = tierProblems(broken);
    expect(problems).toHaveLength(5);
  });

  it('spreads cells evenly over the cell accounts', () => {
    expect([1, 2, 3, 4].map((c) => cellAccountOf(TIERS.large, c))).toEqual([1, 1, 2, 2]);
    expect([1, 2].map((c) => cellAccountOf(TIERS.medium, c))).toEqual([1, 2]);
    expect(() => cellAccountOf(TIERS.small, 2)).toThrow(/outside 1..1/);
  });
});
