// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sink app (stress ADR-0022): one stack, `StressRunSink`, in the platform account.
 * `deploy-sink.sh` and `remove-sink.sh` run it. Environment: `STRESS_CELL_ACCOUNTS` (the cell
 * accounts file; only the account ids are read), `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`.
 */

import * as fs from 'node:fs';
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { RunSinkStack } from './sink.cdk';

const file = process.env.STRESS_CELL_ACCOUNTS;
if (file === undefined || file === '') throw new Error('STRESS_CELL_ACCOUNTS is not set');
const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts?: { accountId?: unknown }[] };
const ids = (doc.accounts ?? []).map((a) => a.accountId);
if (!ids.every((a): a is string => typeof a === 'string' && /^[0-9]{12}$/.test(a))) throw new Error(`${file}: an account id is not 12 digits`);

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
new RunSinkStack(app, 'StressRunSink', {
  cellAccountIds: ids,
  description: 'Stress run dashboard: the observability sink the cell accounts link to (stress ADR-0022)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
app.synth();
