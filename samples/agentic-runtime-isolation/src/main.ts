// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { bundleAgent } from './agent/bundle';
import { parseDemoContext, RuntimeIsolationDemoStack } from './demo.cdk';

const app = new App();

// Security linting (cdk-nag v3): every construct is evaluated against the AWS
// Solutions rule pack at synth time. Findings fail synthesis; intentional
// deviations are acknowledged per construct with a reason that cites an ADR.
// The construct carries its own acknowledgments (standard §4.5), so a
// consumer who applies cdk-nag sees the same result as this app.
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);

// Deployment inputs (spec §3.3) from --context; synth fails fast naming any
// missing or malformed key. The stack name embeds the ingress so both can be
// deployed side by side; the second needs --context publishParameters=false,
// which moves its registry and published parameters under a stack-scoped
// prefix, because the default prefix is account-wide (ADR-0024).
const context = parseDemoContext((key) => app.node.tryGetContext(key), process.env.CDK_DEFAULT_REGION);

new RuntimeIsolationDemoStack(app, `RuntimeIsolation-${context.ingress}`, {
  context,
  agentCodePath: bundleAgent(),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
