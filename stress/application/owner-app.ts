// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The account owner's app for a cell account (README): `CellPolicies`, `CellAccountBase`
 * and the temporary `CellBoundaryProbe`. `deploy-owner.sh` and `probe-deploy.sh` run it
 * with the owner's credentials; it needs no CDK bootstrap (legacy synthesizer).
 *
 * Environment: `CELL_POLICY_SUFFIX` (optional, e.g. `-v2`: a new set of policy names beside
 * an old one), `CELL_USER_POOL_ID` and `CELL_APP_CLIENT_ID` (optional, both or neither: the
 * stress identity a cell trusts, written to the identity parameters), `PLATFORM_ACCOUNT_ID`
 * (optional: the platform account of a platform run, which gets the ingress reader role in
 * `CellAccountBase`) and `CELL_OWNER_STACKS` (optional: `base` makes `CellPolicies` no part of
 * the app, for the second Region of an account that already has the policies: their names
 * are account-wide) and `OBSERVABILITY_SINK_ARN` (optional: the platform account's observability
 * sink, `stress/dashboard/deploy-sink.sh`; `CellAccountBase` then holds the one link that shows
 * this account on the run dashboard, stress ADR-0022).
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CellAccountBaseStack, CellPoliciesStack } from './cell-account.cdk';
import { cellPolicyNames } from './cell-policies';
import { CellBoundaryProbeStack } from './cell-probe.cdk';

const names = cellPolicyNames(process.env.CELL_POLICY_SUFFIX ?? '');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const blank = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
const owned = blank(process.env.CELL_OWNER_STACKS);
if (owned !== undefined && owned !== 'base') throw new Error('CELL_OWNER_STACKS must be empty or `base`');

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
if (owned === undefined) {
  new CellPoliciesStack(app, 'CellPolicies', { env, names, description: 'Cell account owner: the cell policies (stress ADR-0006, ADR-0011)' });
}
new CellAccountBaseStack(app, 'CellAccountBase', {
  env,
  userPoolId: blank(process.env.CELL_USER_POOL_ID),
  appClientId: blank(process.env.CELL_APP_CLIENT_ID),
  platformAccountId: blank(process.env.PLATFORM_ACCOUNT_ID),
  observabilitySinkArn: blank(process.env.OBSERVABILITY_SINK_ARN),
  description: 'Cell account owner: API Gateway logs role and the identity parameters (spec §3.7)',
});
new CellBoundaryProbeStack(app, 'CellBoundaryProbe', { env, names, description: 'Temporary: the cell permissions boundary probe role (probes.sh)' });
app.synth();
