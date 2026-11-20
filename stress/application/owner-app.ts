// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The account owner's app for a cell account (README): `CellPolicies`, `CellAccountBase`
 * and the temporary `CellBoundaryProbe`. `deploy-owner.sh` and `probe-deploy.sh` run it
 * with the owner's credentials; it needs no CDK bootstrap (legacy synthesizer).
 *
 * Environment: `CELL_POLICY_SUFFIX` (optional, e.g. `-v2`: a new set of policy names beside
 * an old one), `CELL_USER_POOL_ID` and `CELL_APP_CLIENT_ID` (optional, both or neither: the
 * stress identity a cell trusts, written to the identity parameters).
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CellAccountBaseStack, CellPoliciesStack } from './cell-account.cdk';
import { cellPolicyNames } from './cell-policies';
import { CellBoundaryProbeStack } from './cell-probe.cdk';

const names = cellPolicyNames(process.env.CELL_POLICY_SUFFIX ?? '');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const blank = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
new CellPoliciesStack(app, 'CellPolicies', { env, names, description: 'Cell account owner: the cell policies (stress ADR-0006, ADR-0011)' });
new CellAccountBaseStack(app, 'CellAccountBase', {
  env,
  userPoolId: blank(process.env.CELL_USER_POOL_ID),
  appClientId: blank(process.env.CELL_APP_CLIENT_ID),
  description: 'Cell account owner: API Gateway logs role and the identity parameters (spec §3.7)',
});
new CellBoundaryProbeStack(app, 'CellBoundaryProbe', { env, names, description: 'Temporary: the cell permissions boundary probe role (probes.sh)' });
app.synth();
