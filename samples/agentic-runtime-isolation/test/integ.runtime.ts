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
 * | `api-gateway`        | api-gateway       | every module on, two backends with their own needs and tools, no floor, demo tenant data | 3 to 9, 9-registry |
 * | `agentcore-gateway`  | agentcore-gateway | every module on, two backends with their own needs and tools, no floor, demo tenant data | 3 to 9, 9-registry |
 * | `session-off`        | api-gateway       | session off, no floor, default role                       | 4a, ADR-0018  |
 * | `narrowed`           | api-gateway       | floor `default/chat`, two backends, 5 requests/min        | floor, limits |
 *
 * The all-on stacks carry no ingress-wide floor (ADR-0025). The `narrowed`
 * stack keeps the floor (`default/chat`, AND) in front of the two backends'
 * own needs, so the run shows both checks on one route. Its suffix is kept
 * from v1 so `scripts/integ.sh` still finds it; v2 has no narrowed tokens
 * (the agent receives a transaction token, ADR-0031).
 *
 * `session-off` runs on the construct's default model-only TenantModelRole
 * (no `tvm.role`), so the run also proves a model call is signed by a
 * tenant-tagged role when the deployer brings none (ADR-0018).
 *
 * The published parameters have fixed names, so only the `api-gateway`
 * stack writes them. Dashboards are account-wide names, so each stack names
 * its own after the stack.
 *
 * (v2, ADR-0035) Each stack has its own entitlement store, so the name
 * reservations no longer collide across stacks; every stack keeps its own
 * default owner marker.
 *
 * TODO(v2): the v2 steps of spec §8 are not scripted yet. `scripts/integ.sh`
 * still runs the v1 narrowed-token and scope-catalogue steps; it needs:
 *   - entitlement API steps: subscribe tenant A to `default` and `billing`
 *     through the vendor routes, cut user A2 through the tenant-admin route;
 *   - the transaction token: the agent's report shows `sub = <tenant>#<sub>`,
 *     `aud`, `act` and the granted scopes; refused with a v1 registry entry;
 *   - the tools Gateway: `tools` lists only granted tools, `tool crm/get_account`
 *     succeeds, `tool invoices/get_invoice` is refused on the default backend,
 *     a tampered `_ri_ctx` is refused by the tool (`context_invalid`);
 *   - per-tenant tool rate limits (`tenantRateLimit`, ADR-0039);
 *   - multiTenant: a token with `tenants` and no `X-Tenant-Id` is refused
 *     `tenant_required`;
 *   - JWKS and discovery routes answer without auth, and a key rotation
 *     (`keyGeneration: 2`) keeps the old key in the JWKS for one ttl.
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
  // TODO(v2): turn multiTenant on for one all-on stack once integ.sh has the tenant-selection steps.
  multiTenant: false,
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
    multiTenant: false,
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
    // The ingress-wide floor (ADR-0005) on the default backend's one need.
    requiredScopes: ['default/chat'],
    multiTenant: false,
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
