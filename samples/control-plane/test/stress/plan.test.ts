// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  applicationDefinition,
  drawsOf,
  maxCellsPerAccount,
  parseBuildLimit,
  parseCellAccounts,
  parseTier,
  scalingLimitsFor,
  stackNamesOf,
  tenantSetsOf,
  type TierSizes,
} from './plan';

const SMALL: TierSizes = { name: 'small', cellAccounts: 1, cells: 1, maxTenants: 25, tenantsSeeded: 20, onboarding: 'every-run', churnPerRun: 5, steadyRps: 10, scenarioSeconds: 60 };
const MEDIUM: TierSizes = { ...SMALL, name: 'medium', cellAccounts: 2, cells: 2, maxTenants: 110, tenantsSeeded: 200, churnPerRun: 20, steadyRps: 100 };
const LARGE: TierSizes = { ...MEDIUM, name: 'large', cells: 4, maxTenants: 1025, tenantsSeeded: 4000, churnPerRun: 100, onboarding: 'fixture' };

describe('names', () => {
  it('derive the stacks and the fleet from the prefix', () => {
    expect(stackNamesOf('StressW5')).toEqual({ setup: 'StressW5-cp-setup', controlPlane: 'StressW5-control-plane', fleet: 'stressw5' });
  });
  it('refuse a prefix that is not a fleet name, or names the sample\'s or an integration test\'s fleet', () => {
    for (const bad of [undefined, 'x', '1abc', 'a_b', `S${'a'.repeat(32)}`, 'Control-Plane', 'cp-integ-r1']) {
      expect(() => stackNamesOf(bad)).toThrow(/STRESS_PREFIX/);
    }
  });
});

describe('the build limit (ADR-0046)', () => {
  it('defaults to 50 and takes 1 to 100', () => {
    expect(parseBuildLimit(undefined)).toBe(50);
    expect(parseBuildLimit('5')).toBe(5);
    for (const bad of ['0', '101', '2.5', 'x']) expect(() => parseBuildLimit(bad)).toThrow(/1 to 100/);
  });
  it('scales through 5, 20 and 50, never above the deployed limit', () => {
    expect(scalingLimitsFor(50)).toEqual([5, 20, 50]);
    expect(scalingLimitsFor(20)).toEqual([5, 20]);
    expect(scalingLimitsFor(4)).toEqual([]);
  });
});

describe('the tier', () => {
  it('reads the fields the slice uses from STRESS_TIER_JSON', () => {
    expect(parseTier(JSON.stringify({ ...SMALL, agentsPerCell: 2 }))).toEqual(SMALL);
  });
  it('refuses a broken tier', () => {
    expect(() => parseTier('nope')).toThrow(/not JSON/);
    expect(() => parseTier(JSON.stringify({ ...SMALL, cells: 3, cellAccounts: 2 }))).toThrow(/evenly/);
    expect(() => parseTier(JSON.stringify({ ...SMALL, onboarding: 'sometimes' }))).toThrow(/onboarding/);
    expect(() => parseTier(JSON.stringify({ ...SMALL, churnPerRun: 0 }))).toThrow(/churnPerRun/);
  });
  it('spreads the cells over the accounts and fills each cell exactly with the seeded and churn tenants', () => {
    for (const t of [SMALL, MEDIUM, LARGE]) {
      const sets = tenantSetsOf(t);
      expect(sets.seeded + sets.churn).toBe(t.cells * t.maxTenants);
      expect(sets.extra).toBe(sets.churn);
    }
    expect(maxCellsPerAccount(LARGE)).toBe(2);
  });
});

describe('the budget (spec §4.4)', () => {
  it('draws the build limit on both projects, and a little STS in every cell account', () => {
    expect(drawsOf(SMALL, 50)).toEqual([
      { account: 'platform', quota: 'codebuild-linux-small', amount: 100 },
      { account: 'platform', quota: 'lambda-concurrency', amount: 120 },
      { account: 'platform', quota: 'sts-assume-role-rps', amount: 3 },
      { account: 'cell-account-1', quota: 'sts-assume-role-rps', amount: 1 },
    ]);
    expect(drawsOf(MEDIUM, 5).map((d) => d.account)).toEqual(['platform', 'platform', 'platform', 'cell-account-1', 'cell-account-2']);
  });
});

describe('the cell accounts file', () => {
  const stackArn = (account: string, name: string): string => `arn:aws:cloudformation:eu-central-1:${account}:stack/${name}/00000000-0000-0000-0000-000000000001`;
  const entry = (n: number, account: string) => ({ label: `cell-account-${n}`, accountId: account, profile: `cell${n}`, accountBaseStackArns: [stackArn(account, 'CellPolicies')] });
  const file = (accounts: unknown[]) => JSON.stringify({ accounts });

  it('keeps the tier\'s first accounts', () => {
    const got = parseCellAccounts(file([entry(1, '111111111111'), entry(2, '222222222222')]), 'f', SMALL, '999999999999');
    expect(got.map((a) => a.label)).toEqual(['cell-account-1']);
  });
  it('refuses the platform account, too few accounts, a wrong label, a duplicate, and a stack ARN of another account', () => {
    expect(() => parseCellAccounts(file([entry(1, '999999999999')]), 'f', SMALL, '999999999999')).toThrow(/platform account/);
    expect(() => parseCellAccounts(file([entry(1, '111111111111')]), 'f', MEDIUM, '999999999999')).toThrow(/needs 2/);
    expect(() => parseCellAccounts(file([{ ...entry(1, '111111111111'), label: 'a' }]), 'f', SMALL, '9')).toThrow(/label/);
    expect(() => parseCellAccounts(file([entry(1, '111111111111'), entry(2, '111111111111')]), 'f', SMALL, '9')).toThrow(/twice/);
    const foreign = { ...entry(1, '111111111111'), accountBaseStackArns: [stackArn('222222222222', 'CellPolicies')] };
    expect(() => parseCellAccounts(file([foreign]), 'f', SMALL, '9')).toThrow(/not a stack ARN of/);
    expect(() => parseCellAccounts(file([{ ...entry(1, '111111111111'), accountBaseStackArns: [] }]), 'f', SMALL, '9')).toThrow(/must list/);
  });
});

describe('the stress application', () => {
  it('runs the stress application scripts from the S3 source, fills cells and declares its parameters', () => {
    const d = applicationDefinition(SMALL, 'bucket/source/abc.zip', '-w10') as any;
    expect(d.source).toEqual({ type: 'S3', location: 'bucket/source/abc.zip' });
    expect(d.cellScripts.create).toBe('stress/application/scripts/cell/create.sh');
    expect(d.tenantScripts.delete).toBe('stress/application/scripts/tenant/delete.sh');
    expect(d.maxTenants).toBe(25);
    expect(d.placementStrategy).toBe('FILL');
    expect(d.hooks).toEqual([]);
    expect(d.cellParameters).toEqual([expect.objectContaining({ name: 'CELL_POLICY_SUFFIX', default: '-w10' })]);
    expect(d.parameters.map((p: any) => p.name)).toEqual(['AGENTS', 'TOOLS']);
  });
  it('refuses a policy suffix the owner stacks would refuse', () => {
    expect(() => applicationDefinition(SMALL, 'b/k', 'w10')).toThrow(/suffix/);
  });
});
