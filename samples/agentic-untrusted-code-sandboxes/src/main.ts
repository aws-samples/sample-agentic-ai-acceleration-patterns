// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Demo app. Context (fail fast on anything missing or malformed, standard §4.3):
 *   backends    comma list of microvm, nitro, agentcore (required)
 *   standalone  true or false (required)
 * Both are real choices, as a deploy makes them; `npx projen build` passes
 * all three backends and standalone=true. The app needs no other input.
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DemoStack, readContext } from './demo.cdk';

const app = new App();
const ctx = readContext((k) => app.node.tryGetContext(k));
new DemoStack(app, 'UntrustedCodeSandboxes', {
  backends: ctx.backends,
  standalone: ctx.standalone,
});
// cdk-nag v3: findings fail synth; suppressions carry a reason that cites an
// ADR or a mitigation, and the construct carries its own (standard §4.5).
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);
