// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The dashboard app (stress ADR-0022): one stack, `<STRESS_PREFIX>-dashboard`, with the run's
 * dashboard. `dashboard.sh` synthesises it from `stress/`, with `stress/`'s own aws-cdk-lib.
 *
 * Environment: `STRESS_PREFIX` (letters and digits, as for the driver), `STRESS_DASHBOARD_PLAN_FILE`
 * (the plan the runner wrote), `STRESS_CELL_ACCOUNTS` (the cell accounts file; only the account ids
 * are read), `STRESS_FD_IDENTITY_REGION` (optional), `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`.
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { RunDashboardStack } from './dashboard.cdk';
import { planFromFiles } from './plan';

const PREFIX = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const prefix = process.env.STRESS_PREFIX ?? '';
if (!PREFIX.test(prefix)) throw new Error('STRESS_PREFIX must be 1 to 40 letters and digits, starting with a letter');
const planFile = process.env.STRESS_DASHBOARD_PLAN_FILE;
if (planFile === undefined || planFile === '') throw new Error('STRESS_DASHBOARD_PLAN_FILE is not set');
const plan = planFromFiles(planFile, process.env.STRESS_CELL_ACCOUNTS);
const region = process.env.CDK_DEFAULT_REGION;
if (region !== plan.region) throw new Error('the Region of the credentials is not the Region of the run: set AWS_REGION to the run\'s Region');

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
new RunDashboardStack(app, `${prefix}-dashboard`, { prefix, plan, env: { account: process.env.CDK_DEFAULT_ACCOUNT, region } });
app.synth();
