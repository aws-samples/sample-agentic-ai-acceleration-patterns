// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The driver app (stress ADR-0009): one stack, `<STRESS_PREFIX>-driver`, the k6 host and its
 * results bucket. `deploy.sh` and `teardown.sh` in this folder synthesise it; a slice's own
 * scripts call them. It runs from `stress/`, with `stress/`'s own aws-cdk-lib, so a sample
 * never loads a second copy of the CDK.
 *
 * Environment: `STRESS_TIER` (small, medium, large; picks the instance type from
 * `src/tiers.ts`), `STRESS_PREFIX` (stack name prefix), `STRESS_PARAMETER_PREFIXES` (a
 * comma-separated list of SSM parameter path prefixes the host may read besides
 * tenant-identity's; a slice passes its registry prefix).
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { StressDriverStack } from './stress-driver.cdk';
import { tierOf } from '../src/tiers';

const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

const prefix = process.env.STRESS_PREFIX ?? '';
if (!PREFIX.test(prefix)) {
  throw new Error('STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter');
}
const tier = tierOf(process.env.STRESS_TIER);
const parameterPrefixes = (process.env.STRESS_PARAMETER_PREFIXES ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
new StressDriverStack(app, `${prefix}-driver`, {
  instanceType: tier.driverInstanceType,
  parameterPrefixes,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
app.synth();
