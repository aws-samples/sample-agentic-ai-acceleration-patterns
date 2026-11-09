// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A stress agents stack (stress-test plan §8.3, row 2): one slice of the
 * tier's agents behind the stress ingress, read from its published document
 * (`SharedIngress.fromParameters`, ADR-0042). A synth-time lookup, so the
 * stack needs `env: { account, region }` and is deployed after the ingress
 * stack. Exists at `medium` (one stack) and `large` (five).
 */

import { CfnOutput, Stack, StackProps, Token } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { namePart, STRESS_OWNER } from './stress-ingress.cdk';
import { agentsOfStack, type StressTier, targetNames } from './tiers';
import { AgentBackend } from '../../src/agent-backend.cdk';
import { defaultModelId } from '../../src/demo.cdk';
import { SharedIngress } from '../../src/shared-ingress.cdk';

export interface StressAgentsStackProps extends StackProps {
  readonly tier: StressTier;
  /** Which agents stack, 1-based. */
  readonly index: number;
  /** Directory with the bundled agent (`app.js`); see src/agent/bundle.ts. */
  readonly agentCodePath: string;
  /** The stress ingress stack's registry prefix, where it publishes (§8.3). */
  readonly registryPrefix: string;
}

export class StressAgentsStack extends Stack {
  readonly agents: AgentBackend[] = [];

  constructor(scope: Construct, id: string, props: StressAgentsStackProps) {
    super(scope, id, props);
    const names = agentsOfStack(props.tier, props.index);
    if (names.length === 0) {
      throw new Error(`StressAgentsStack: tier '${props.tier.name}' has no agents stack ${props.index} (it has ${props.tier.agentStacks})`);
    }
    const ingress = SharedIngress.fromParameters(this, 'Ingress', props.registryPrefix, 'api-gateway');
    const modelId = defaultModelId(Token.isUnresolved(this.region) ? undefined : this.region);
    const firstTarget = targetNames(props.tier)[0];
    for (const name of names) {
      const backend = new AgentBackend(this, `Agent${namePart(name)}`, {
        name,
        ingress,
        agent: { codePath: props.agentCodePath, modelId },
        needs: [`${name}/chat`],
        tools: [`${firstTarget}/*`],
        owner: STRESS_OWNER,
      });
      this.agents.push(backend);
    }
    new CfnOutput(this, 'AgentNames', { value: names.join(',') });
  }
}
