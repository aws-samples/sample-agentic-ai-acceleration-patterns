// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { parseDemoContext, TenantEncryptedIngestionDemoStack } from './demo.cdk';

const app = new App();

// Security linting (cdk-nag v3): every construct is evaluated against the AWS
// Solutions rule pack at synth time. Findings fail synthesis; intentional
// deviations are acknowledged per construct with a reason that cites an ADR
// or a threat-model mitigation. The construct carries its own
// acknowledgments (standard §4.5).
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

// Deployment inputs (spec §3.3) from --context; synth fails fast naming any
// missing or malformed key.
const context = parseDemoContext((key) => app.node.tryGetContext(key));

new TenantEncryptedIngestionDemoStack(app, 'TenantEncryptedIngestion', {
  context,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
