// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Stress-test app (design/agentic-runtime-isolation.stress-test.md §8.3),
 * synthesised by `scripts/stress/deploy.sh` into `cdk.stress.out/`.
 *
 * | Stack                 | Holds                                                    | When |
 * |-----------------------|----------------------------------------------------------|------|
 * | `<prefix>-ingress`    | `StressIngressStack`: the ingress, the default agent, the tool targets | always |
 * | `<prefix>-agents-<k>` | `StressAgentsStack`: a slice of the agents, from the published document | medium (k = 1), large (k = 1..5); not with `STRESS_AGENTS=false` |
 * | `<prefix>-driver`     | `StressDriverStack`: the k6 host and the results bucket | not with `STRESS_DRIVER=false` |
 *
 * Environment: `STRESS_PREFIX` (default `RuntimeIsolationStress`),
 * `STRESS_SCALE` (`small`, `medium`, `large`; default `small`),
 * `STRESS_DRIVER` and `STRESS_AGENTS` (`false` leaves those stacks out; the
 * first deploy runs with `STRESS_AGENTS=false`, before the published
 * document the agents stacks read exists).
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { StressAgentsStack } from './stress/stress-agents.cdk';
import { StressDriverStack } from './stress/stress-driver.cdk';
import { StressIngressStack, stressRegistryPrefix } from './stress/stress-ingress.cdk';
import { tierOf } from './stress/tiers';
import { bundleAgent } from '../src/agent/bundle';

/** Stack name prefix, validated like `INTEG_PREFIX`. */
export const STRESS_PREFIX = process.env.STRESS_PREFIX || 'RuntimeIsolationStress';
if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(STRESS_PREFIX)) {
  throw new Error(`STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter: ${STRESS_PREFIX}`);
}

function enabled(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === '' || value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false (got ${value})`);
}

const tier = tierOf(process.env.STRESS_SCALE);
const withDriver = enabled('STRESS_DRIVER');
const withAgents = enabled('STRESS_AGENTS');

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const agentCodePath = bundleAgent();
const ingressStackName = `${STRESS_PREFIX}-ingress`;
const registryPrefix = stressRegistryPrefix(ingressStackName);

new StressIngressStack(app, ingressStackName, { tier, agentCodePath, env });

if (withAgents) {
  for (let index = 1; index <= tier.agentStacks; index++) {
    new StressAgentsStack(app, `${STRESS_PREFIX}-agents-${index}`, { tier, index, agentCodePath, registryPrefix, env });
  }
}

if (withDriver) {
  new StressDriverStack(app, `${STRESS_PREFIX}-driver`, { tier, registryPrefix, env });
}

app.synth();
