// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The cell side of the probes: `CellWorkloadProbe`, synthesised as a cell is (the cell
 * synth context, the `/cell/` aspect) and deployed through the cell bootstrap by
 * `probe-deploy.sh`. Environment: `CELL_POLICY_SUFFIX`, as for `owner-app.ts`.
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { cellSynthContext } from './cell-path';
import { cellPolicyNames } from './cell-policies';
import { CellWorkloadProbeStack } from './cell-probe.cdk';

const names = cellPolicyNames(process.env.CELL_POLICY_SUFFIX ?? '');
const app = new App({ context: cellSynthContext(names) });
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
new CellWorkloadProbeStack(app, 'CellWorkloadProbe', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'Temporary: cell roles under the workload boundary (probes.sh)',
});
app.synth();
