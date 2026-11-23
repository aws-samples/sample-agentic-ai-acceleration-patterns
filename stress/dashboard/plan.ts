// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import { type DashboardPlan, type RunPart } from './widgets';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ACCOUNT_ID = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const QUOTA_PAIR = /^(platform|cell-account-[1-9][0-9]*):[a-z0-9-]+$/;

/**
 * The plan of a run, from the file the runner writes when the run starts (`dashboard-plan.json` in
 * the run folder) and the cell accounts file (`STRESS_CELL_ACCOUNTS`, the account ids only). Every
 * value is checked, because the plan ends up in a CloudFormation template and in CLI arguments.
 */
export function planFromFiles(planFile: string, cellAccountsFile: string | undefined, env: NodeJS.ProcessEnv = process.env): DashboardPlan {
  const doc = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Record<string, unknown>;
  const text = (key: string, rule: RegExp): string => {
    const v = doc[key];
    if (typeof v !== 'string' || !rule.test(v)) throw new Error(`${planFile}: ${key} is missing or malformed`);
    return v;
  };
  const runs = doc.runs;
  if (!Array.isArray(runs) || !runs.every((r): r is RunPart => typeof r?.slice === 'string' && NAME.test(r.slice) && typeof r?.scenario === 'string' && NAME.test(r.scenario))) {
    throw new Error(`${planFile}: runs must list {slice, scenario}`);
  }
  const quotas = doc.quotas;
  if (!Array.isArray(quotas) || !quotas.every((q) => typeof q === 'string' && QUOTA_PAIR.test(q))) throw new Error(`${planFile}: quotas must list <account>:<quota>`);
  const iso = (key: string): string | undefined => {
    const v = doc[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${planFile}: ${key} must be a timestamp`);
    return v;
  };
  const accounts: string[] = [];
  if (cellAccountsFile !== undefined && cellAccountsFile !== '') {
    const file = JSON.parse(fs.readFileSync(cellAccountsFile, 'utf8')) as { accounts?: { accountId?: unknown }[] };
    for (const a of file.accounts ?? []) {
      if (typeof a.accountId !== 'string' || !ACCOUNT_ID.test(a.accountId)) throw new Error(`${cellAccountsFile}: an account id is not 12 digits`);
      accounts.push(a.accountId);
    }
  }
  const identityRegion = env.STRESS_FD_IDENTITY_REGION;
  if (identityRegion !== undefined && identityRegion !== '' && !REGION.test(identityRegion)) throw new Error('STRESS_FD_IDENTITY_REGION is not a Region');
  const tier = text('tier', /^(small|medium|large)$/);
  // A slice-mode run has no cell account to show: the plan's cell accounts are the tier's.
  const tierAccounts = { small: 1, medium: 2, large: 2 }[tier as 'small' | 'medium' | 'large'];
  return {
    runId: text('runId', RUN_ID),
    tier,
    commit: text('commit', /^[0-9a-f]{7,40}$/),
    region: text('region', REGION),
    ...(identityRegion === undefined || identityRegion === '' ? {} : { identityRegion }),
    runs,
    cellAccounts: accounts.slice(0, tierAccounts),
    quotas: quotas as string[],
    ...(iso('start') === undefined ? {} : { start: iso('start') }),
    ...(iso('end') === undefined ? {} : { end: iso('end') }),
  };
}
