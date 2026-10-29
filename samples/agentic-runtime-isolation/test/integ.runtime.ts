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
 * | `api-gateway`        | api-gateway       | every module on, two backends with their own scopes, no floor, demo tenant data | 3 to 9, 9-registry |
 * | `agentcore-gateway`  | agentcore-gateway | every module on, two backends with their own scopes, no floor, demo tenant data | 3 to 9, 9-registry |
 * | `session-off`        | api-gateway       | session off, no floor, no forwarding, default role        | 4a, ADR-0018  |
 * | `narrowed`           | api-gateway       | floor `default/chat`, two backends, forwarding with requireNarrowedToken, 5 requests/min | 8 (narrowed), floor, limits |
 *
 * The all-on stacks carry no ingress-wide floor (ADR-0025): the integration
 * test narrows tokens to one backend scope at a time (`billing/read` alone
 * must reach billing), which a floor would refuse. The `narrowed` stack keeps
 * the floor (`default/chat`, AND) in front of the two backends' own scopes
 * (OR), with `allowedScopes` naming all three, so the run shows both checks
 * on one route: the floor alone is refused on billing, a billing scope alone
 * is refused by the floor, and the two together pass.
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
  // api-gateway checks the opt-in per-tenant metrics (ADR-0021); the
  // agentcore-gateway stack runs with them off, the default.
  perTenantMetrics: ingress === 'api-gateway',
  sessionScope: 'user',
  forwardUserToken: true,
  requireNarrowedToken: false,
  tvm: true,
  includeUserIdTag: false,
  modelId,
  identityParameterPlaceholders: false,
  publishParameters: true,
  billingBackend: true,
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
    publishParameters: true,
  },
  'narrowed': {
    ingress: 'api-gateway',
    // Low per-tenant limit (ADR-0020): the integ shows tenant A limited while tenant B is not.
    requestsPerMinute: 5,
    sessionScope: 'user',
    // The ingress-wide floor (ADR-0005) and the narrowed-token rule
    // (ADR-0007) on the default backend's one scope.
    requiredScopes: ['default/chat'],
    forwardUserToken: true,
    requireNarrowedToken: true,
    allowedScopes: ['default/chat', 'billing/read', 'billing/invoke'],
    billingBackend: true,
    tvm: false,
    includeUserIdTag: false,
    modelId,
    identityParameterPlaceholders: false,
    publishParameters: true,
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
