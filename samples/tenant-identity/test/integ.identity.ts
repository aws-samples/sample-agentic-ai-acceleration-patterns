// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Deployment integration test (spec §10, docs/sample-standard.md §5.2).
 *
 * Deploys the three topology stacks in parallel, runs the spec §10 scenario
 * against each as integ-runner's postDeploy hook, then destroys everything.
 * Run through the `integ` projen task in EXACTLY ONE Region (the task fails
 * fast when AWS_REGION is unset).
 *
 * Hook robustness: integ-runner runs hook commands with the working directory
 * set to the snapshot's parent (not this sample), and splits each command on
 * whitespace with no shell — so `&&`, env-var prefixes and quoting are not
 * available. Both hooks are therefore a single binary invocation by absolute
 * path, computed from `__dirname` at synth time:
 *   - postDeploy runs the sample's local jest against the e2e config, which
 *     discovers each `TenantIdentity-<topology>` stack by its CloudFormation
 *     outputs and runs the scenario (E2E_STACK_PREFIX defaults to
 *     TenantIdentity, AWS_REGION is inherited from the task).
 *   - preDestroy runs test/e2e/cleanup.ts through the local ts-node, deleting
 *     any tenant still in each stack's registry so `cdk destroy` can remove
 *     the stacks and `pool-per-tenant` leaves no pools (spec P-4, §6.2).
 */

import * as path from 'path';
import { IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, CfnWaitConditionHandle, Stack } from 'aws-cdk-lib';
import { TenantIdentityStack } from '../src/identity.cdk';
import { TOPOLOGIES, Topology } from '../src/shared/constants';

const STACK_PREFIX = 'TenantIdentity';

// Absolute paths resolved at synth time, so the hooks work from any cwd.
const sampleDir = path.resolve(__dirname, '..');
const jestBin = path.join(sampleDir, 'node_modules', '.bin', 'jest');
const tsNodeBin = path.join(sampleDir, 'node_modules', '.bin', 'ts-node');
const e2eConfig = path.join(sampleDir, 'test', 'e2e', 'jest.config.json');
const cleanupScript = path.join(sampleDir, 'test', 'e2e', 'cleanup.ts');

const app = new App();

// One stack per topology, named exactly as the e2e scenario discovers them
// (`${E2E_STACK_PREFIX}-${topology}`, default prefix TenantIdentity).
// The R-6 parameter names are fixed per account and Region, so exactly one
// of the three stacks publishes them (ADR-0017). The e2e scenario checks
// that the publisher's parameters name its own stack.
const PUBLISHER: Topology = 'shared-pool-multi-tenant';

const stacks = TOPOLOGIES.map(
  (topology) =>
    new TenantIdentityStack(app, `${STACK_PREFIX}-${topology}`, {
      topology,
      publishSharedParameters: topology === PUBLISHER,
    }),
);

const region = process.env.AWS_REGION;

const integ = new IntegTest(app, 'TenantIdentityInteg', {
  testCases: stacks,
  // Deploy to one Region only (the task enforces AWS_REGION is set).
  regions: region === undefined || region === '' ? undefined : [region],
  cdkCommandOptions: { destroy: { args: { force: true } } },
  hooks: {
    // Run the spec §10 scenario against the three deployed stacks.
    postDeploy: [`${jestBin} --config ${e2eConfig}`],
    // Drain every tenant so cdk destroy can remove the stacks cleanly.
    preDestroy: [`${tsNodeBin} ${cleanupScript}`],
  },
});

// CloudFormation refuses an empty stack, and integ-tests-alpha always adds an
// assertion stack. Its awsApiCall assertions run in a Lambda whose log group
// no stack owns (ADR-0019), so the R-6 parameter checks run in the e2e
// scenario instead, and the assertion stack holds one inert resource.
new CfnWaitConditionHandle((integ.assertions as unknown as { scope: Stack }).scope, 'Placeholder');
