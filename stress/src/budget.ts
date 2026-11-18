// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The quota budget (spec §4.4, P-4). Each slice's `budget` verb prints what
 * it draws on each account-wide quota at the tier; the runner adds the draws
 * up per account and refuses to start when a sum is over the account's
 * limit. Limits come from Service Quotas where the quota has a code, and
 * from the documented default otherwise.
 */

export interface QuotaInfo {
  readonly description: string;
  /** Service Quotas service and quota code, when the quota is listed there. */
  readonly serviceCode?: string;
  readonly quotaCode?: string;
  /** The service default, used when the account's value cannot be read. */
  readonly defaultLimit: number;
}

export const QUOTAS = {
  'lambda-concurrency': {
    description: 'Lambda concurrent executions',
    serviceCode: 'lambda',
    quotaCode: 'L-B99A9384',
    defaultLimit: 1000,
  },
  'codebuild-linux-small': {
    description: 'CodeBuild concurrently running builds, Linux/Small',
    serviceCode: 'codebuild',
    quotaCode: 'L-9D07B6EF',
    defaultLimit: 1,
  },
  'kms-rsa-rps': {
    description: 'KMS cryptographic operations (RSA) per second',
    serviceCode: 'kms',
    quotaCode: 'L-2AC98190',
    defaultLimit: 1000,
  },
  'sts-assume-role-rps': {
    description: 'STS AssumeRole per second (not in Service Quotas)',
    defaultLimit: 600,
  },
  'agentcore-new-sessions-rps': {
    description: 'AgentCore Runtime new sessions per second',
    serviceCode: 'bedrock-agentcore',
    quotaCode: 'L-8EE2AEA2',
    defaultLimit: 25,
  },
  'agentcore-active-sessions': {
    description: 'AgentCore Runtime active session workloads',
    serviceCode: 'bedrock-agentcore',
    quotaCode: 'L-3E5722B2',
    defaultLimit: 2500,
  },
  'agentcore-runtime-tps': {
    description: 'AgentCore Runtime invocations per second',
    defaultLimit: 1000,
  },
  'cognito-groups': {
    description: 'Cognito groups per user pool (two per tenant), hard',
    defaultLimit: 10000,
  },
} as const satisfies Record<string, QuotaInfo>;

export type QuotaId = keyof typeof QUOTAS;

export function isQuotaId(value: unknown): value is QuotaId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUOTAS, value);
}

/** One line of a slice's `budget` output. `account` is `platform` or `cell-<n>`. */
export interface Draw {
  readonly account: string;
  readonly quota: QuotaId;
  readonly amount: number;
}

const ACCOUNT_LABEL = /^(platform|cell-[1-9][0-9]*)$/;

/** Parses one slice's `budget` output: `{"draws": [{account, quota, amount}]}`. */
export function parseDraws(slice: string, text: string): Draw[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${slice}: budget printed no JSON`);
  }
  const draws = (doc as { draws?: unknown }).draws;
  if (!Array.isArray(draws)) {
    throw new Error(`${slice}: budget output has no "draws" array`);
  }
  return draws.map((d, i) => {
    const { account, quota, amount } = (d ?? {}) as Record<string, unknown>;
    if (typeof account !== 'string' || !ACCOUNT_LABEL.test(account)) {
      throw new Error(`${slice}: draws[${i}].account must be "platform" or "cell-<n>"`);
    }
    if (!isQuotaId(quota)) {
      throw new Error(`${slice}: draws[${i}].quota ${JSON.stringify(quota)} is not a known quota (${Object.keys(QUOTAS).join(', ')})`);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`${slice}: draws[${i}].amount must be a non-negative number`);
    }
    return { account, quota, amount };
  });
}

/** account -> quota -> summed draw. */
export type Sums = Map<string, Map<QuotaId, number>>;

export function sumDraws(draws: readonly Draw[]): Sums {
  const sums: Sums = new Map();
  for (const d of draws) {
    const perAccount = sums.get(d.account) ?? new Map<QuotaId, number>();
    perAccount.set(d.quota, (perAccount.get(d.quota) ?? 0) + d.amount);
    sums.set(d.account, perAccount);
  }
  return sums;
}

/** account -> quota -> the account's limit; a missing entry uses the default. */
export type Limits = Readonly<Record<string, Partial<Record<QuotaId, number>>>>;

export interface Overdraw {
  readonly account: string;
  readonly quota: QuotaId;
  readonly sum: number;
  readonly limit: number;
}

export function overdraws(sums: Sums, limits: Limits = {}): Overdraw[] {
  const out: Overdraw[] = [];
  for (const [account, perAccount] of sums) {
    for (const [quota, sum] of perAccount) {
      const limit = limits[account]?.[quota] ?? QUOTAS[quota].defaultLimit;
      if (sum > limit) {
        out.push({ account, quota, sum, limit });
      }
    }
  }
  return out;
}
