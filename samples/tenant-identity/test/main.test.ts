// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { TenantIdentityStack } from '../src/identity.cdk';
import { DEPLOYMENTS, parseDeployment } from '../src/shared/constants';

// src/main.ts resolves the deployment with parseDeployment(context) and fails
// synth if it is missing or misspelled (spec §10 step 1, P-7, ADR-0001,
// ADR-0027). We exercise the same code path the app uses - context
// resolution plus parseDeployment - without spawning a child process.
function resolveTopologyFromContext(context: Record<string, unknown>): string {
  const app = new App({ context });
  return parseDeployment(app.node.tryGetContext('topology'));
}

describe('deploy inputs (spec §10 step 1)', () => {
  test('synth without topology fails naming all four accepted values', () => {
    try {
      resolveTopologyFromContext({});
      throw new Error('expected parseDeployment to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/missing/i);
      for (const value of DEPLOYMENTS) {
        expect(message).toContain(value);
      }
    }
  });

  test('a misspelled topology fails the same way, naming all four values', () => {
    try {
      resolveTopologyFromContext({ topology: 'shared_pool' }); // underscore, not hyphen
      throw new Error('expected parseDeployment to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("'shared_pool'");
      for (const value of DEPLOYMENTS) {
        expect(message).toContain(value);
      }
    }
  });

  test.each(DEPLOYMENTS)('each accepted value resolves and names a stack TenantIdentity-%s', (topology) => {
    expect(resolveTopologyFromContext({ topology })).toBe(topology);
    // And the app composes a stack with the topology-embedded name.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
      topology,
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    expect(stack.stackName).toBe(`TenantIdentity-${topology}`);
  });
});
