// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The account owner's app for the control-plane role pair of a cell account (spec §3.7,
 * README step 4; stress ADR-0012): control-plane's own `CellAccountStack`, deployed with
 * the CDK's legacy synthesizer as plain CloudFormation with the owner's credentials, no
 * service role and no CDK bootstrap. Its roles stay on `/` with no cell boundary.
 * `deploy-role-pair.sh` runs it.
 *
 * Environment: `STRESS_FLEET_NAME` (the control plane's fleet name), `CONTROL_PLANE_ACCOUNT_ID`
 * (the platform account), `CELL_POLICY_SUFFIX` (optional, as for the owner stacks), and
 * `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` from the CDK CLI.
 *
 * The stack and the app must load one copy of the CDK, so both come from control-plane's
 * `node_modules` (the sample's `npm ci`), not from this package's.
 */

import * as path from 'node:path';
import { rolePairProps } from './role-pair';

const controlPlane = path.resolve(__dirname, '..', '..', 'samples', 'control-plane');
/* eslint-disable @typescript-eslint/no-require-imports */
const cdk = require(require.resolve('aws-cdk-lib', { paths: [controlPlane] })) as typeof import('aws-cdk-lib');
const { CellAccountStack } = require(path.join(controlPlane, 'src', 'cell-account', 'cell-account.cdk')) as {
  CellAccountStack: new (scope: unknown, id: string, props: Record<string, unknown>) => unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const props = rolePairProps({
  fleetName: need('STRESS_FLEET_NAME'),
  controlPlaneAccountId: need('CONTROL_PLANE_ACCOUNT_ID'),
  cellAccountId: need('CDK_DEFAULT_ACCOUNT'),
  policySuffix: process.env.CELL_POLICY_SUFFIX ?? '',
});

const app = new cdk.App();
new CellAccountStack(app, props.stackName, {
  controlPlaneAccountId: props.controlPlaneAccountId,
  fleetName: props.fleetName,
  cellBuildManagedPolicyArns: props.cellBuildManagedPolicyArns,
  tenantBuildManagedPolicyArns: props.tenantBuildManagedPolicyArns,
  synthesizer: new cdk.LegacyStackSynthesizer(),
  description: `Cell account owner: the ${props.fleetName} control plane role pair (spec §3.7, control-plane ADR-0025, ADR-0047)`,
  env: { account: need('CDK_DEFAULT_ACCOUNT'), region: need('CDK_DEFAULT_REGION') },
});
app.synth();
