// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §8, standard §5.2).
 *
 * The stacks, deployed at once by `scripts/integ.sh` (the `integ` projen
 * task) with the CDK CLI, because integ-runner deploys and destroys one
 * stack at a time:
 *
 * | Stack suffix         | Ingress           | Modules                                                          | Spec §8 steps |
 * |----------------------|-------------------|------------------------------------------------------------------|---------------|
 * | `api-gateway`        | api-gateway       | all on: session `tenant`, both agents, both tools gateways, demo tenant data, tool test mode, the test mint; publishes the parameters | 3 to 9, 9-registry, 11 to 24 |
 * | `agentcore-gateway`  | agentcore-gateway | the same, not publishing                                         | 3 to 9, 9-registry, 11 to 20, 22 to 24 |
 * | `session-off`        | api-gateway       | session off, default model-only tenant role                      | 4a, ADR-0018 |
 * | `session-user`       | api-gateway       | session `user`                                                   | 4b (`scope: 'user'`) |
 * | `limits`             | api-gateway       | 5 requests per tenant per minute, the floor `app/use`            | limits, the floor |
 * | `multi-tenant`       | api-gateway       | `identity.multiTenant` on, the issuer of a second tenant-identity (`shared-pool-multi-tenant`) | 19 (MU) |
 *
 * `multi-tenant` exists only when the driver passes that deployment's pool
 * and client (`INTEG_MT_USER_POOL_ID`, `INTEG_MT_APP_CLIENT_ID`): a
 * `SharedIngress` trusts one issuer, so the user in several tenants signs in
 * at its own tenant-identity and reaches its own ingress.
 *
 * The test-only mint function (test/integ/mint.function.ts, granted
 * `TokenSigner.grantSign`) exists only on the two all-on stacks, never in the
 * demo stack. `INTEG_KEY_GENERATION` sets `transactionToken.keyGeneration`
 * on the `api-gateway` stack (step 21 redeploys it with 2).
 *
 * The published parameters have fixed names, so only the `api-gateway`
 * stack writes them (none with `INTEG_PUBLISHER=none`); the others publish
 * under `<prefix><stackName>/`.
 * Dashboards are account-wide names, so each stack names its own after the
 * stack. Each stack has its own entitlement store, so name reservations do
 * not collide across stacks; every stack passes `owner:
 * 'RuntimeIsolationInteg'` (spec §8 step 2).
 */

import * as path from 'node:path';
import { App, CfnOutput, Duration } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { INTEG_MINT_ENV } from './integ/mint.function';
import { bundleAgent } from '../src/agent/bundle';
import { DemoContext, defaultModelId, RuntimeIsolationDemoStack } from '../src/demo.cdk';
import { acknowledgeLambdaFindings, functionProps } from '../src/shared/function.cdk';

/**
 * Stack name prefix. `INTEG_PREFIX` lets a run deploy beside the stacks of an
 * earlier run that could not be deleted (DELETE_FAILED stacks cannot be updated);
 * the owner stays `RuntimeIsolationInteg` (each stack has its own store).
 */
export const STACK_PREFIX = process.env.INTEG_PREFIX || 'RuntimeIsolationInteg';
if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(STACK_PREFIX)) {
  throw new Error(`INTEG_PREFIX must be 1 to 40 letters and digits, starting with a letter: ${STACK_PREFIX}`);
}
export const INTEG_OWNER = 'RuntimeIsolationInteg';

const modelId = process.env.INTEG_MODEL_ID ?? defaultModelId(process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION);
const keyGeneration = process.env.INTEG_KEY_GENERATION === undefined ? undefined : Number(process.env.INTEG_KEY_GENERATION);

const base = {
  multiTenant: false,
  includeUserIdTag: false,
  modelId,
  identityParameterPlaceholders: false,
  publishParameters: true,
  owner: INTEG_OWNER,
} as const;

const allOn = (ingress: DemoContext['ingress']): DemoContext => ({
  ...base,
  ingress,
  // api-gateway checks the opt-in per-tenant metrics (ADR-0021); the
  // agentcore-gateway stack runs with them off, the default.
  perTenantMetrics: ingress === 'api-gateway',
  // The default (ADR-0039): A1 and A2 share a conversation they both name.
  sessionScope: 'tenant',
  tvm: true,
  billingBackend: true,
  keyGeneration: ingress === 'api-gateway' ? keyGeneration : undefined,
});

/** Which stacks get the test mint and the tools' test mode. */
const TEST_HOOKS = new Set(['api-gateway', 'agentcore-gateway', 'multi-tenant']);
const MINT = new Set(['api-gateway', 'agentcore-gateway']);

export const INTEG_STACKS: Record<string, DemoContext> = {
  'api-gateway': allOn('api-gateway'),
  'agentcore-gateway': allOn('agentcore-gateway'),
  'session-off': { ...base, ingress: 'api-gateway', tvm: false },
  'session-user': { ...base, ingress: 'api-gateway', sessionScope: 'user', tvm: false },
  'limits': {
    ...base,
    ingress: 'api-gateway',
    // Low per-tenant limit (ADR-0020): the integ shows tenant A limited while tenant B is not.
    requestsPerMinute: 5,
    sessionScope: 'tenant',
    // The ingress-wide floor (ADR-0005): the application scope every identity token carries.
    requiredScopes: ['app/use'],
    tvm: false,
  },
};

const mtPool = process.env.INTEG_MT_USER_POOL_ID;
const mtClient = process.env.INTEG_MT_APP_CLIENT_ID;
if (mtPool !== undefined && mtPool !== '' && mtClient !== undefined && mtClient !== '') {
  INTEG_STACKS['multi-tenant'] = { ...base, ingress: 'api-gateway', multiTenant: true, sessionScope: 'tenant', tvm: true };
}
// INTEG_PUBLISHER=none: no stack writes the fixed-name parameters, because
// they are already taken (another deployment, or an earlier run's
// DELETE_FAILED stack); CloudFormation refuses to create an existing name.
const PUBLISHER = process.env.INTEG_PUBLISHER ?? 'api-gateway';

const app = new App();
const agentCodePath = bundleAgent();

for (const [suffix, context] of Object.entries(INTEG_STACKS)) {
  const stackName = `${STACK_PREFIX}-${suffix}`;
  const stack = new RuntimeIsolationDemoStack(app, stackName, {
    agentCodePath,
    publishParameters: suffix === PUBLISHER,
    dashboardName: stackName,
    context,
    identity: suffix === 'multi-tenant' ? { userPoolId: mtPool!, appClientId: mtClient! } : undefined,
    toolTestMode: TEST_HOOKS.has(suffix),
  });
  if (MINT.has(suffix)) {
    // TEST ONLY (spec §8): signs tokens the ingress would never mint, with the ingress's own key.
    const mint = new NodejsFunction(stack, 'IntegMintFunction', {
      ...functionProps(stack, 'IntegMintLogs', Duration.seconds(10)),
      entry: path.join(__dirname, 'integ', 'mint.function.ts'),
      description: 'runtime-isolation INTEGRATION TEST ONLY: mints transaction tokens for the negative steps (spec §8)',
      environment: {
        [INTEG_MINT_ENV.ISSUER]: stack.ingress.issuer,
        [INTEG_MINT_ENV.KEY_ID]: stack.ingress.tokenSigner.keyId,
        [INTEG_MINT_ENV.INGRESS_ROLE_ARN]: stack.ingress.ingressRole.roleArn,
      },
    });
    acknowledgeLambdaFindings(mint);
    stack.ingress.tokenSigner.grantSign(mint);
    new CfnOutput(stack, 'MintFunctionName', { value: mint.functionName });
  }
}

app.synth();
