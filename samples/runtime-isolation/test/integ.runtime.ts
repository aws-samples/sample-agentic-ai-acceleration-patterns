// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §8, standard §5.2).
 *
 * Four demo stacks, deployed at once by `scripts/integ.sh` (the `integ`
 * projen task) with the CDK CLI, because integ-runner deploys and destroys
 * one stack at a time:
 *
 * | Stack suffix         | Ingress           | Modules                                                   | Spec §8 steps |
 * |----------------------|-------------------|-----------------------------------------------------------|---------------|
 * | `api-gateway`        | api-gateway       | every module on, demo tenant data                         | 3 to 9        |
 * | `agentcore-gateway`  | agentcore-gateway | every module on, demo tenant data                         | 3 to 9        |
 * | `session-off`        | api-gateway       | session off, no scope check, no forwarding, default role  | 4a, ADR-0018  |
 * | `narrowed`           | api-gateway       | forwarding with requireNarrowedToken                      | 8 (narrowed)  |
 *
 * `session-off` runs on the construct's default model-only TenantModelRole
 * (no `tvm.role`), so the run also proves a model call is signed by a
 * tenant-tagged role when the deployer brings none (ADR-0018).
 *
 * The published parameters have fixed names, so only the `api-gateway`
 * stack writes them. Dashboards are account-wide names, so each stack names
 * its own after the stack.
 */

import { App } from 'aws-cdk-lib';
import { bundleAgent } from '../src/agent/bundle';
import { DemoContext, defaultModelId, RuntimeIsolationDemoStack } from '../src/demo.cdk';

export const STACK_PREFIX = 'RuntimeIsolationInteg';

const modelId = process.env.INTEG_MODEL_ID ?? defaultModelId(process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION);

const allOn = (ingress: DemoContext['ingress']): DemoContext => ({
  ingress,
  sessionScope: 'user',
  requiredScopes: ['tenant-api/read'],
  forwardUserToken: true,
  requireNarrowedToken: false,
  tvm: true,
  includeUserIdTag: false,
  modelId,
  identityParameterPlaceholders: false,
});

export const INTEG_STACKS: Record<string, DemoContext> = {
  'api-gateway': allOn('api-gateway'),
  'agentcore-gateway': allOn('agentcore-gateway'),
  'session-off': {
    ingress: 'api-gateway',
    forwardUserToken: false,
    requireNarrowedToken: false,
    tvm: false,
    includeUserIdTag: false,
    modelId,
    identityParameterPlaceholders: false,
  },
  'narrowed': {
    ingress: 'api-gateway',
    sessionScope: 'user',
    forwardUserToken: true,
    requireNarrowedToken: true,
    allowedScopes: ['tenant-api/read'],
    tvm: false,
    includeUserIdTag: false,
    modelId,
    identityParameterPlaceholders: false,
  },
};
const PUBLISHER = 'api-gateway';

const app = new App();
const agentCodePath = bundleAgent();

for (const [suffix, context] of Object.entries(INTEG_STACKS)) {
  const stackName = `${STACK_PREFIX}-${suffix}`;
  new RuntimeIsolationDemoStack(app, stackName, {
    agentCodePath,
    publishParameters: suffix === PUBLISHER,
    dashboardName: stackName,
    context,
  });
}

app.synth();
