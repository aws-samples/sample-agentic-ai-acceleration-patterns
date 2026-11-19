// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { parseDemoContext, TenantUsageMeteringDemoStack } from './demo.cdk';

const app = new App();

// Security linting (cdk-nag): findings fail synthesis; each intentional
// deviation is acknowledged on its construct with a reason citing an ADR or a
// threat-model mitigation (standard §4.3).
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

// Every resource carries the sample tag, so teardown can be proven by tag.
Tags.of(app).add('sample', 'tenant-usage-metering');

// `-c stackName=...` deploys a second demo stack beside the first (with its own fleetName).
new TenantUsageMeteringDemoStack(app, (app.node.tryGetContext('stackName') as string | undefined) ?? 'TenantUsageMetering', {
  description: 'Tenant usage metering for agentic applications (aws-samples, MIT-0)',
  context: parseDemoContext((key) => app.node.tryGetContext(key)),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

app.synth();
