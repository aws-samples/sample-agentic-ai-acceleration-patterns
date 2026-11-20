// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * What the control-plane stress slice does at a tier (platform stress test,
 * docs/stress-test.spec.md §3.6, §4.1, §4.4, §5.2): the names it deploys under, the stress
 * application's definition, the tenant sets, the build limits and its draw on each
 * account-wide quota. Pure: no AWS call, so `budget` runs without credentials.
 */

export type Mode = 'slice' | 'platform';

/** The part of the runner's `STRESS_TIER_JSON` this slice reads. */
export interface TierSizes {
  readonly name: string;
  readonly cellAccounts: number;
  readonly cells: number;
  readonly maxTenants: number;
  readonly tenantsSeeded: number;
  readonly onboarding: 'every-run' | 'fixture';
  readonly churnPerRun: number;
  readonly steadyRps: number;
  readonly scenarioSeconds: number;
}

/** Spec §3.6: the stress deployment's builds per project. ADR-0046 caps it at 100. */
export const DEFAULT_BUILD_LIMIT = 50;
/** Spec §5.2: the build limits the scaling scenario steps through. */
export const SCALING_LIMITS = [5, 20, 50] as const;
/** The CodeBuild projects that run builds for the stress application: cell and tenant, no hooks (spec §3.6). */
export const BUILD_PROJECTS = 2;
/** The stress application's id. */
export const APPLICATION_ID = 'stress';

const PREFIX = /^[A-Za-z][A-Za-z0-9-]{2,31}$/;
const FLEET = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface StackNames {
  readonly setup: string;
  readonly controlPlane: string;
  /** The control plane's fleet name: the prefix in lower case. */
  readonly fleet: string;
}

/**
 * The stack names and fleet for a prefix. Refuses a prefix whose fleet would be the sample's
 * default (`control-plane`) or an integration test's (`cp-integ-*`), so the stress control
 * plane never shares role, project or workflow names with one of them.
 */
export function stackNamesOf(prefix: string | undefined): StackNames {
  if (prefix === undefined || !PREFIX.test(prefix)) throw new Error(`STRESS_PREFIX must match ${PREFIX}`);
  const fleet = prefix.toLowerCase();
  if (!FLEET.test(fleet)) throw new Error(`STRESS_PREFIX in lower case must be a fleet name (${FLEET})`);
  if (fleet === 'control-plane' || fleet.startsWith('cp-integ-')) {
    throw new Error('STRESS_PREFIX must not name the sample\'s own fleet or an integration test\'s');
  }
  return { setup: `${prefix}-cp-setup`, controlPlane: `${prefix}-control-plane`, fleet };
}

export function parseBuildLimit(text: string | undefined): number {
  if (text === undefined || text === '') return DEFAULT_BUILD_LIMIT;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('STRESS_BUILD_LIMIT must be an integer from 1 to 100 (ADR-0046)');
  return n;
}

export function parseMode(text: string | undefined): Mode {
  if (text !== 'slice' && text !== 'platform') throw new Error('STRESS_MODE must be slice or platform');
  return text;
}

function count(v: unknown, field: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new Error(`STRESS_TIER_JSON.${field} must be an integer of at least ${min}`);
  }
  return v;
}

export function parseTier(text: string | undefined): TierSizes {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text ?? '') as Record<string, unknown>;
  } catch {
    throw new Error('STRESS_TIER_JSON is not JSON');
  }
  if (typeof doc.name !== 'string') throw new Error('STRESS_TIER_JSON.name must be a string');
  if (doc.onboarding !== 'every-run' && doc.onboarding !== 'fixture') throw new Error('STRESS_TIER_JSON.onboarding must be every-run or fixture');
  const tier: TierSizes = {
    name: doc.name,
    cellAccounts: count(doc.cellAccounts, 'cellAccounts', 1),
    cells: count(doc.cells, 'cells', 1),
    maxTenants: count(doc.maxTenants, 'maxTenants', 1),
    tenantsSeeded: count(doc.tenantsSeeded, 'tenantsSeeded', 1),
    onboarding: doc.onboarding,
    churnPerRun: count(doc.churnPerRun, 'churnPerRun', 1),
    steadyRps: count(doc.steadyRps, 'steadyRps', 1),
    scenarioSeconds: count(doc.scenarioSeconds, 'scenarioSeconds', 1),
  };
  if (tier.cells % tier.cellAccounts !== 0) throw new Error('STRESS_TIER_JSON: cells must spread evenly over the cell accounts');
  return tier;
}

/** Cells each cell account may hold: the tier's cells spread evenly (spec §4.1). */
export const maxCellsPerAccount = (t: TierSizes): number => t.cells / t.cellAccounts;

/**
 * The tenant sets the seed creates (control-plane records only; no build runs):
 * `seeded` is onboarded by PS-1, `churn` fills the free slots in the scenarios, and `extra`
 * is as many again, the tenants a placement race must refuse.
 */
export function tenantSetsOf(t: TierSizes): { seeded: number; churn: number; extra: number } {
  return { seeded: t.tenantsSeeded, churn: t.churnPerRun, extra: t.churnPerRun };
}

/** The scaling limits the build limit allows (spec §5.2): never above the deployed limit. */
export const scalingLimitsFor = (buildLimit: number): number[] => SCALING_LIMITS.filter((l) => l <= buildLimit);

export interface Draw {
  readonly account: string;
  readonly quota: 'codebuild-linux-small' | 'lambda-concurrency' | 'sts-assume-role-rps';
  readonly amount: number;
}

/**
 * The slice's draw on each account-wide quota (spec §4.4). In the platform account: the
 * build limit on each of the two projects (Linux/Small); the API and authorizer functions
 * at the read rate plus a workflow callback per running build (Lambda concurrency); one role
 * pair AssumeRole per build start, the limit's builds starting within a minute at most
 * (STS). In each cell account, a cell build assumes the cell bootstrap's three roles.
 */
export function drawsOf(t: TierSizes, buildLimit: number): Draw[] {
  const builds = buildLimit * BUILD_PROJECTS;
  const draws: Draw[] = [
    { account: 'platform', quota: 'codebuild-linux-small', amount: builds },
    { account: 'platform', quota: 'lambda-concurrency', amount: 2 * t.steadyRps + builds },
    { account: 'platform', quota: 'sts-assume-role-rps', amount: Math.ceil(builds / 60) + 1 },
  ];
  for (let n = 1; n <= t.cellAccounts; n += 1) {
    draws.push({ account: `cell-account-${n}`, quota: 'sts-assume-role-rps', amount: 1 });
  }
  return draws;
}

/** A cell account the operator lists for the run (spec §3.7), from `STRESS_CELL_ACCOUNTS`. */
export interface CellAccountInput {
  readonly label: string;
  readonly accountId: string;
  /** The AWS CLI profile of the account owner's read access, for the account check. */
  readonly profile: string;
  /** The account-base stacks the owner deployed, by stack ARN (spec §3.7). */
  readonly accountBaseStackArns: readonly string[];
}

const ACCOUNT = /^\d{12}$/;
const PROFILE = /^[A-Za-z0-9_.-]{1,64}$/;
const STACK_ARN = /^arn:aws[a-z-]*:cloudformation:[a-z0-9-]+:(\d{12}):stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[0-9a-f-]{36}$/;

/** Parses the cell accounts file and keeps the tier's first `cellAccounts`. */
export function parseCellAccounts(text: string, file: string, t: TierSizes, platformAccount: string): CellAccountInput[] {
  let doc: { accounts?: unknown };
  try {
    doc = JSON.parse(text) as { accounts?: unknown };
  } catch {
    throw new Error(`${file}: not JSON`);
  }
  if (!Array.isArray(doc.accounts)) throw new Error(`${file}: "accounts" must be an array`);
  const accounts = doc.accounts.map((a: unknown, i: number): CellAccountInput => {
    const { label, accountId, profile, accountBaseStackArns } = (a ?? {}) as Record<string, unknown>;
    if (label !== `cell-account-${i + 1}`) throw new Error(`${file}: accounts[${i}].label must be cell-account-${i + 1}`);
    if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) throw new Error(`${file}: accounts[${i}].accountId must be 12 digits`);
    if (accountId === platformAccount) throw new Error(`${file}: accounts[${i}] is the platform account, never a cell account (spec §3.1)`);
    if (typeof profile !== 'string' || !PROFILE.test(profile)) throw new Error(`${file}: accounts[${i}].profile must match ${PROFILE}`);
    if (!Array.isArray(accountBaseStackArns) || accountBaseStackArns.length === 0) {
      throw new Error(`${file}: accounts[${i}].accountBaseStackArns must list the account-base stacks`);
    }
    for (const arn of accountBaseStackArns) {
      const m = typeof arn === 'string' ? STACK_ARN.exec(arn) : null;
      if (m === null || m[1] !== accountId) throw new Error(`${file}: accounts[${i}].accountBaseStackArns holds a value that is not a stack ARN of ${accountId}`);
    }
    return { label, accountId, profile, accountBaseStackArns: accountBaseStackArns as string[] };
  });
  if (new Set(accounts.map((a) => a.accountId)).size !== accounts.length) throw new Error(`${file}: an account is listed twice`);
  if (accounts.length < t.cellAccounts) throw new Error(`${file}: the ${t.name} tier needs ${t.cellAccounts} cell accounts, the file lists ${accounts.length}`);
  return accounts.slice(0, t.cellAccounts);
}

/** The stress application's definition (control-plane `PutApplication`, spec §3.1). */
export function applicationDefinition(t: TierSizes, sourceLocation: string, cellPolicySuffix: string): Record<string, unknown> {
  if (!/^(-[a-z0-9]{1,16})?$/.test(cellPolicySuffix)) throw new Error('the cell policy suffix must be empty or - and 1 to 16 lower-case letters or digits');
  const scripts = (kind: 'cell' | 'tenant') => ({
    create: `stress/application/scripts/${kind}/create.sh`,
    update: `stress/application/scripts/${kind}/update.sh`,
    delete: `stress/application/scripts/${kind}/delete.sh`,
  });
  return {
    source: { type: 'S3', location: sourceLocation },
    cellScripts: scripts('cell'),
    tenantScripts: scripts('tenant'),
    maxTenants: t.maxTenants,
    placementStrategy: 'FILL',
    parameters: [
      { name: 'AGENTS', required: false, default: 'default', description: 'Agents the tenant is subscribed to on its cell, comma-separated' },
      { name: 'TOOLS', required: false, default: '', description: 'Tools the tenant is subscribed to on its cell, comma-separated' },
    ],
    cellParameters: [{ name: 'CELL_POLICY_SUFFIX', default: cellPolicySuffix, description: 'The cell policy suffix of the cell accounts (stress/application)' }],
    hooks: [],
  };
}
