// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { drawsOf, parameterNameOf, parseMode, parseTier, planOf, stackNameOf } from './plan';

const SMALL = JSON.stringify({
  name: 'small', tenantsSeeded: 20, tenantsActive: 20, usersPerActiveTenant: 2, onboarding: 'every-run', churnPerRun: 5, steadyRps: 10, scenarioSeconds: 60,
});
const LARGE = JSON.stringify({
  name: 'large', tenantsSeeded: 4000, tenantsActive: 1000, usersPerActiveTenant: 1, onboarding: 'fixture', churnPerRun: 100, steadyRps: 500, scenarioSeconds: 600,
});

describe('stack and parameter names', () => {
  test('the stress stack is named under the prefix', () => {
    expect(stackNameOf('stress-w6')).toBe('stress-w6-identity');
    expect(parameterNameOf('stress-w6')).toBe('/stress-w6/identity');
  });

  test.each(['TenantIdentity', 'tenantidentity-x', 'TENANTIDENTITYscopes'])('refuses %s, the integration tests\' prefix', (prefix) => {
    expect(() => stackNameOf(prefix)).toThrow(/TenantIdentity/);
  });

  test.each([undefined, '', 'a', '1abc', 'has space', 'x'.repeat(50)])('refuses the prefix %p', (prefix) => {
    expect(() => stackNameOf(prefix)).toThrow(/STRESS_PREFIX/);
  });
});

describe('tier and mode', () => {
  test('parses what the runner passes', () => {
    expect(parseTier(SMALL).tenantsSeeded).toBe(20);
    expect(parseMode('slice')).toBe('slice');
  });

  test.each([undefined, '', '{"name":"x"}', JSON.stringify({ ...JSON.parse(SMALL), tenantsActive: 99 })])('refuses the tier %p', (json) => {
    expect(() => parseTier(json)).toThrow();
  });

  test.each([0, -1])('refuses steadyRps %p, which would stall the open loop', (steadyRps) => {
    expect(() => parseTier(JSON.stringify({ ...JSON.parse(SMALL), steadyRps }))).toThrow(/steadyRps/);
  });

  test('the control plane\'s tenants count only in platform mode', () => {
    expect(planOf(parseTier(SMALL), 'slice').controlPlaneTenants).toBe(0);
    expect(planOf(parseTier(SMALL), 'platform').controlPlaneTenants).toBe(25);
  });

  test('refuses an unknown mode', () => {
    expect(() => parseMode('both')).toThrow(/STRESS_MODE/);
  });
});

describe('plan', () => {
  test('small, alone: seeds the tier and onboards its churn count', () => {
    const plan = planOf(parseTier(SMALL), 'slice');
    expect(plan).toMatchObject({ seedTenants: 20, activeTenants: 20, extraUsers: 1, onboardTenants: 5, burstTenants: 20, burstConcurrency: 20 });
    expect(plan.peakPoolTenants).toBe(40);
  });

  test('platform mode seeds a probe set; the control plane brings the rest', () => {
    const plan = planOf(parseTier(LARGE), 'platform');
    expect(plan.seedTenants).toBe(20);
    expect(plan.peakPoolTenants).toBe(4000 + 100 + 20 + 400);
  });

  test('large, alone, stays under the pool cap of 10,000 groups', () => {
    const plan = planOf(parseTier(LARGE), 'slice');
    expect(plan.onboardConcurrency).toBe(50);
    expect(plan.burstConcurrency).toBe(100);
    expect(2 * plan.peakPoolTenants).toBeLessThanOrEqual(10_000);
  });
});

describe('budget', () => {
  test('every draw is on the platform account and a quota slice.json declares', () => {
    const declared: { quotas: string[] } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../scripts/stress/slice.json'), 'utf8'));
    for (const mode of ['slice', 'platform'] as const) {
      const draws = drawsOf(planOf(parseTier(SMALL), mode));
      expect(draws.every((d) => d.account === 'platform' && Number.isInteger(d.amount) && d.amount >= 0)).toBe(true);
      expect(draws.map((d) => d.quota).sort()).toEqual([...declared.quotas].sort());
    }
  });

  test('groups are two per tenant at the pool\'s peak', () => {
    const draws = drawsOf(planOf(parseTier(SMALL), 'slice'));
    expect(draws.find((d) => d.quota === 'cognito-groups')?.amount).toBe(80);
  });

  test('the auth rate covers the unpaced onboardings of PS-1 and the burst', () => {
    // small: 20 burst onboardings at once, two users each.
    expect(drawsOf(planOf(parseTier(SMALL), 'slice')).find((d) => d.quota === 'cognito-user-authentication-rps')?.amount).toBe(40);
    // large: the steady rate is higher than 100 onboardings of one user.
    expect(drawsOf(planOf(parseTier(LARGE), 'slice')).find((d) => d.quota === 'cognito-user-authentication-rps')?.amount).toBe(500);
  });
});
