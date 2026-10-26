// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §8, standard §5.2).
 *
 * One demo stack per ingress, with every module on, so the spec §8 steps 3
 * to 8a run against both ingresses from one deployment each. `scripts/integ.sh`
 * (the `integ` projen task) deploys tenant-identity (`shared-pool`) unless its
 * parameters are already published (ADR-0004, tenant-identity ADR-0017),
 * synthesises this app, deploys both stacks at once with the CDK CLI, runs
 * the steps, and always destroys what it deployed. The CDK CLI drives the run
 * because integ-runner deploys and destroys one stack at a time.
 *
 * Option toggles the steps need in the OFF state (4a: `session` off; 7, 8:
 * scopes and narrowing off) are separate deployments of src/main.ts with
 * different context; the script runs those after the ON pass.
 *
 * The published parameters have fixed names, so only the api-gateway stack
 * writes them here.
 */

import { App } from 'aws-cdk-lib';
import { bundleAgent } from '../src/agent/bundle';
import { DEFAULT_MODEL_ID, DemoContext, RuntimeIsolationDemoStack } from '../src/demo.cdk';

export const STACK_PREFIX = 'RuntimeIsolationInteg';
export const INGRESSES: DemoContext['ingress'][] = ['api-gateway', 'agentcore-gateway'];
const PUBLISHER: DemoContext['ingress'] = 'api-gateway';

const app = new App();
const agentCodePath = bundleAgent();

for (const ingress of INGRESSES) {
  new RuntimeIsolationDemoStack(app, `${STACK_PREFIX}-${ingress}`, {
    agentCodePath,
    publishParameters: ingress === PUBLISHER,
    context: {
      ingress,
      sessionScope: 'user',
      requiredScopes: ['tenant-api/read'],
      forwardUserToken: true,
      requireNarrowedToken: false,
      tvm: true,
      includeUserIdTag: false,
      modelId: process.env.INTEG_MODEL_ID ?? DEFAULT_MODEL_ID,
      identityParameterPlaceholders: false,
    },
  });
}

app.synth();
