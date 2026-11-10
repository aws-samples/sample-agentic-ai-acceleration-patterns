// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The stress-test scale tiers (design/agentic-runtime-isolation.stress-test.md
 * §8.2). `STRESS_SCALE` picks one; `small` is the default. The CDK app, the
 * scripts and k6 read the same figures.
 */

/** One scale tier (§8.2). */
export interface StressTier {
  readonly name: 'small' | 'medium' | 'large';
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
  readonly tenantsSeeded: number;
  readonly tenantsActive: number;
  readonly usersPerActiveTenant: number;
  /** S1 rate, requests per second. */
  readonly steadyRps: number;
  /** S6 rate, requests per second. */
  readonly peakRps: number;
  /** Scenario length in seconds. At `large` this is the S1 length; the other scenarios use their §5 figures. */
  readonly scenarioSeconds: number;
  readonly stageThrottle: { readonly rateLimit: number; readonly burstLimit: number };
  readonly ingressReservedConcurrency: number;
  readonly driverInstanceType: string;
}

export const STRESS_TIERS: Record<'small' | 'medium' | 'large', StressTier> = {
  small: {
    name: 'small',
    agents: 2,
    agentsPerStack: 20,
    agentStacks: 0,
    toolTargets: 2,
    toolsPerTarget: 10,
    toolsGateways: ['default', 'finance'],
    tenantsSeeded: 20,
    tenantsActive: 20,
    usersPerActiveTenant: 2,
    steadyRps: 10,
    peakRps: 40,
    scenarioSeconds: 60,
    stageThrottle: { rateLimit: 100, burstLimit: 50 },
    ingressReservedConcurrency: 50,
    driverInstanceType: 't3.large',
  },
  medium: {
    name: 'medium',
    agents: 10,
    agentsPerStack: 20,
    agentStacks: 1,
    toolTargets: 4,
    toolsPerTarget: 100,
    toolsGateways: ['default', 'finance', 'hr', 'ops'],
    tenantsSeeded: 200,
    tenantsActive: 200,
    usersPerActiveTenant: 2,
    steadyRps: 100,
    peakRps: 300,
    scenarioSeconds: 180,
    stageThrottle: { rateLimit: 300, burstLimit: 150 },
    ingressReservedConcurrency: 200,
    driverInstanceType: 'c6i.xlarge',
  },
  large: {
    name: 'large',
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
    tenantsSeeded: 10_000,
    tenantsActive: 1_000,
    usersPerActiveTenant: 4,
    steadyRps: 500,
    peakRps: 1_000,
    scenarioSeconds: 600,
    stageThrottle: { rateLimit: 1_200, burstLimit: 600 },
    ingressReservedConcurrency: 800,
    driverInstanceType: 'c6i.2xlarge',
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
