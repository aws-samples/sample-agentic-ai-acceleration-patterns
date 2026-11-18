// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Stack, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();

// Security linting (cdk-nag): findings fail synthesis; each intentional
// deviation is acknowledged on its construct with a reason citing an ADR or a
// threat-model mitigation (standard §4.3).
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

// Every resource carries the sample tag, so teardown can be proven by tag.
Tags.of(app).add('sample', 'tenant-usage-metering');

// The demo stack instantiates the `TenantUsageMetering` construct once it is
// built; until then the app synthesises an empty stack so the build and
// cdk-nag run from the first commit.
new Stack(app, 'TenantUsageMetering', {
  description: 'Tenant usage metering for agentic applications (aws-samples, MIT-0)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

app.synth();
