// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test app (spec §10, docs/sample-standard.md §5.2).
 *
 * One stack per topology. `scripts/integ.sh` (the `integ` projen task)
 * deploys all three at once with `cdk deploy --all --concurrency 3`, runs the
 * spec §10 scenario against them (the e2e jest suite), and always destroys
 * them with `cdk destroy --all --concurrency 3`, pass or fail. The CDK CLI
 * drives the run instead of integ-runner because integ-runner deploys and
 * destroys a test's stacks one at a time (ADR-0023).
 *
 * The scenario leaves one tenant in every stack on purpose: the stack's own
 * TenantDrain must offboard it during the destroy (ADR-0022), and a pool,
 * group, or user left afterwards is the failure signal.
 */

import { App } from 'aws-cdk-lib';
import { TenantIdentityStack } from '../src/identity.cdk';
import { TOPOLOGIES, Topology } from '../src/shared/constants';

const STACK_PREFIX = 'TenantIdentity';

// The R-6 parameter names are fixed per account and Region, so exactly one
// of the three stacks publishes them (ADR-0017). The e2e scenario checks
// that the publisher's parameters name its own stack.
const PUBLISHER: Topology = 'shared-pool-multi-tenant';

const app = new App();

// Named exactly as the e2e scenario discovers them
// (`${E2E_STACK_PREFIX}-${topology}`, default prefix TenantIdentity).
for (const topology of TOPOLOGIES) {
  new TenantIdentityStack(app, `${STACK_PREFIX}-${topology}`, {
    topology,
    publishSharedParameters: topology === PUBLISHER,
  });
}

app.synth();
