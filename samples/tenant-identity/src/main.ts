// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TenantIdentityStack } from './identity.cdk';
import { parseTopology } from './shared/constants';

const app = new App();

// Security linting (cdk-nag v3): evaluate every construct against the AWS
// Solutions rule pack at synth time via CDK's policy validation framework.
// Findings fail synthesis; intentional deviations are acknowledged per
// construct with a reason that cites an ADR or threat-model mitigation.
// writeSuppressionsToCloudFormation copies each acknowledgment into the
// synthesized templates so the audit trail travels with them.
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);

// The one deployment input (spec §3.3, P-7, ADR-0001): the topology. Synth
// fails fast, naming the three accepted values, if it is missing or
// misspelled. The stack name embeds the topology so all three coexist in one
// account and Region (the integration test relies on it).
const topology = parseTopology(app.node.tryGetContext('topology'));

new TenantIdentityStack(app, `TenantIdentity-${topology}`, {
  topology,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
