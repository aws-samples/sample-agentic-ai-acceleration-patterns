// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §10, docs/sample-standard.md §5.2).
 *
 * One stack per deployment: the three topologies plus `tiered` (ADR-0027).
 * `scripts/integ.sh` (the `integ` projen task) deploys them all at once with
 * `cdk deploy --all`, runs the spec §10 scenario against them (the e2e jest
 * suite), and always destroys them with `cdk destroy --all`, pass or fail.
 * The CDK CLI drives the run instead of integ-runner because integ-runner
 * deploys and destroys a test's stacks one at a time (ADR-0023).
 *
 * The scenario leaves one tenant in every stack on purpose: the stack's own
 * TenantDrain must offboard it during the destroy (ADR-0022), and a pool,
 * group, or user left afterwards is the failure signal.
 *
 * Two environment variables let the run share an account with other work:
 * `E2E_STACK_PREFIX` renames the four stacks (default `TenantIdentity`), and
 * `E2E_PUBLISHER` names the deployment that publishes the shared parameters
 * (default `shared-pool-multi-tenant`; `none` publishes from no stack, for an
 * account where another deployment already owns them, ADR-0017).
 */

import { App } from 'aws-cdk-lib';
import { TenantIdentityStack } from '../src/identity.cdk';
import { DEPLOYMENTS } from '../src/shared/constants';

const STACK_PREFIX = process.env.E2E_STACK_PREFIX || 'TenantIdentity';

// The R-6 parameter names are fixed per account and Region, so at most one
// of the stacks publishes them (ADR-0017). The e2e scenario checks that the
// publisher's parameters name its own stack.
const PUBLISHER = process.env.E2E_PUBLISHER || 'shared-pool-multi-tenant';
if (PUBLISHER !== 'none' && !(DEPLOYMENTS as readonly string[]).includes(PUBLISHER)) {
  throw new Error(`E2E_PUBLISHER must be one of ${DEPLOYMENTS.join(', ')} or none, not '${PUBLISHER}'`);
}

const app = new App();

// Named exactly as the e2e scenario discovers them
// (`${E2E_STACK_PREFIX}-${topology}`, default prefix TenantIdentity).
for (const topology of DEPLOYMENTS) {
  new TenantIdentityStack(app, `${STACK_PREFIX}-${topology}`, {
    topology,
    publishSharedParameters: topology === PUBLISHER,
  });
}

app.synth();
