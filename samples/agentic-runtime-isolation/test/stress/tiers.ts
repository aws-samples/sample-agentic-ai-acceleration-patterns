// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { TIERS, type Tier } from '../../../../stress/src/tiers';

/**
 * The stress-test scale tiers (design/agentic-runtime-isolation.stress-test.md
 * §8.2). `STRESS_SCALE` picks one; `small` is the default. The CDK app, the
 * scripts and k6 read the same figures.
 *
 * The figures every slice shares (tenants, users, rates, scenario length, driver
 * instance type) come from `stress/src/tiers.ts` (spec §4.1), so one tier means the same
 * load here and in the platform run. What is below is what only this sample's
 * single-ingress stress stack needs: how many agents, tool targets and gateways one
 * ingress holds, the stage throttle and the reserved concurrencies. The platform run
 * sizes cells per tier instead (`agentsPerCell`, `toolTargetsPerCell`, docs/stress-test.spec.md).
 *
 * Why the shared `large` figures are what they are (2026-11 runs of this sample):
 * - 4,000 tenants seeded: tenant-identity holds two Cognito groups per tenant and a user
 *   pool holds 10,000 groups, a hard quota, so one pool caps at 5,000 tenants (finding
 *   F-11); 4,000 leaves room for the other users of the shared pool.
 * - One user per active tenant: 4,000 live tokens on a 5-minute life need 13 refreshes a
 *   second against the identity /token route at 20 rps, and the S1 run lost 2,338
 *   refreshes to it (F-13). 1,000 tokens refresh at 3.3 a second.
 * - 32 GB driver (c6i.4xlarge): k6 ran a c6i.2xlarge out of memory at 1,600 VUs (F-14).
 */

/** The figures of `stress/src/tiers.ts` this tier uses. */
type SharedFigures = Pick<
  Tier,
  'name' | 'tenantsSeeded' | 'tenantsActive' | 'usersPerActiveTenant' | 'steadyRps' | 'peakRps' | 'scenarioSeconds' | 'driverInstanceType'
>;

function shared(name: Tier['name']): SharedFigures {
  const t = TIERS[name];
  return {
    name: t.name,
    tenantsSeeded: t.tenantsSeeded,
    tenantsActive: t.tenantsActive,
    usersPerActiveTenant: t.usersPerActiveTenant,
    steadyRps: t.steadyRps,
    peakRps: t.peakRps,
    scenarioSeconds: t.scenarioSeconds,
    driverInstanceType: t.driverInstanceType,
  };
}

/** One scale tier (§8.2): the shared figures and this sample's own. */
export interface StressTier extends SharedFigures {
  /** Agents, `default` included. */
  readonly agents: number;
  /** Agents per agents stack (medium, large); the last stack may hold fewer. */
  readonly agentsPerStack: number;
  /** Agents stacks; 0 at `small`, where `a001` sits in the ingress stack. */
  readonly agentStacks: number;
  readonly toolTargets: number;
  readonly toolsPerTarget: number;
  /** Tools gateways of the ingress; the first is `default`. */
  readonly toolsGateways: readonly string[];
  // Every tier sets rateLimit above at least one reserve, on purpose: the
  // peak scenario (S6) runs past the reserve to see the refusal land as a
  // 429 with a tenant, not a bare 500, so every stress synth prints
  // `runtime-isolation:stage-throttle-above-concurrency` (ADR-0049; plan
  // §8.2). stress.cdk.test.ts asserts it.
  readonly stageThrottle: { readonly rateLimit: number; readonly burstLimit: number };
  readonly ingressReservedConcurrency: number;
  /** ADR-0049: the live tokens that may refresh in one second; the driver issues them together, so the whole set (tenantsActive x usersPerActiveTenant). */
  readonly authorizerReservedConcurrency: number;
  /** k6 driver sizing (F-14); run.sh exports these as VU_PER_RPS and TOKENS_IN. Defaults in stress/k6/lib.js when unset. */
  readonly k6?: { readonly vuPerRps?: number; readonly tokensIn?: 'setup' | 'vu' };
}

export const STRESS_TIERS: Record<'small' | 'medium' | 'large', StressTier> = {
  small: {
    ...shared('small'),
    agents: 2,
    agentsPerStack: 20,
    agentStacks: 0,
    toolTargets: 2,
    toolsPerTarget: 10,
    toolsGateways: ['default', 'finance'],
    stageThrottle: { rateLimit: 100, burstLimit: 50 },
    ingressReservedConcurrency: 50,
    authorizerReservedConcurrency: 40,
  },
  medium: {
    ...shared('medium'),
    agents: 10,
    agentsPerStack: 20,
    agentStacks: 1,
    toolTargets: 4,
    toolsPerTarget: 100,
    toolsGateways: ['default', 'finance', 'hr', 'ops'],
    stageThrottle: { rateLimit: 300, burstLimit: 150 },
    ingressReservedConcurrency: 200,
    authorizerReservedConcurrency: 400,
  },
  large: {
    ...shared('large'),
    agents: 100,
    agentsPerStack: 20,
    agentStacks: 5,
    toolTargets: 10,
    toolsPerTarget: 100,
    // Five gateways, 200 tools each. Four gave two gateways 300 tools, and
    // the policy engine's Cedar schema was 413 KB at 300 of these tools,
    // over its 400 KB bound (2026-11-09, finding F-9): the schema holds
    // about 290 tools of this shape, not the 330 the architecture quotes.
    toolsGateways: ['default', 'finance', 'hr', 'ops', 'sales'],
    stageThrottle: { rateLimit: 1_200, burstLimit: 600 },
    ingressReservedConcurrency: 800,
    // Together with the 800 for the integration Lambda that is 1,800 of a
    // 1,000 account pool: the account needs its Lambda concurrency quota
    // raised to about 2,500 before this tier deploys (F-17). CloudFormation
    // refuses a reserve the pool cannot hold.
    authorizerReservedConcurrency: 1_000,
    // k6 driver sizing (F-14): VUs per rps and where tokens live. A report
    // probe takes about 130 ms, so one VU serves several requests a second;
    // 0.25 VUs per rps leaves k6 headroom without 1,600 JavaScript runtimes.
    // 'vu' keeps each VU's tokens in that VU only, not a copy of every entry.
    k6: { vuPerRps: 0.25, tokensIn: 'vu' },
  },
};

/** The tier for `STRESS_SCALE`; unset or empty is `small`, anything else unknown throws. */
export function tierOf(scale: string | undefined): StressTier {
  if (scale === undefined || scale === '') {
    return STRESS_TIERS.small;
  }
  if (!Object.prototype.hasOwnProperty.call(STRESS_TIERS, scale)) {
    throw new Error(`STRESS_SCALE must be one of ${Object.keys(STRESS_TIERS).join(', ')} (got ${scale})`);
  }
  return STRESS_TIERS[scale as keyof typeof STRESS_TIERS];
}

/** Every agent name of the tier: `default`, then `a001`, `a002`, ... */
export function agentNames(tier: StressTier): string[] {
  return ['default', ...Array.from({ length: tier.agents - 1 }, (_, i) => `a${String(i + 1).padStart(3, '0')}`)];
}

/** Every tool target name of the tier: `t01`, `t02`, ... */
export function targetNames(tier: StressTier): string[] {
  return Array.from({ length: tier.toolTargets }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
}

/** The tools gateway of the target at `targetIndex` (0-based): the gateways round-robin. */
export function gatewayOf(tier: StressTier, targetIndex: number): string {
  return tier.toolsGateways[targetIndex % tier.toolsGateways.length];
}

/**
 * The agents of agents stack `index` (1-based): the non-default agents in
 * slices of `agentsPerStack`. Empty at `small`, whose `a001` is in the
 * ingress stack.
 */
export function agentsOfStack(tier: StressTier, index: number): string[] {
  if (!Number.isInteger(index) || index < 1 || index > tier.agentStacks) {
    return [];
  }
  return agentNames(tier)
    .slice(1)
    .slice((index - 1) * tier.agentsPerStack, index * tier.agentsPerStack);
}
