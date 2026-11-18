// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Spike Q-5 (docs/stress-test.spec.md §8, decision 7). Two stacks:
// - CellBootstrapPolicies-spike: the cell execution policy and the cell
//   permissions boundary, from cell-policies.yaml (default bootstrap).
// - CellDenyProbe-spike: one role WITHOUT the boundary and with
//   AdministratorAccess; deployed with --context
//   @aws-cdk/core:bootstrapQualifier=cell it must fail.
// Run with NODE_PATH pointing at a sample's node_modules.
const path = require('node:path');
const { App, Stack } = require('aws-cdk-lib');
const { CfnInclude } = require('aws-cdk-lib/cloudformation-include');
const iam = require('aws-cdk-lib/aws-iam');

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const policies = new Stack(app, 'CellBootstrapPolicies-spike', { env });
new CfnInclude(policies, 'Policies', { templateFile: path.join(__dirname, 'cell-policies.yaml') });

const probe = new Stack(app, 'CellDenyProbe-spike', { env });
new iam.Role(probe, 'UnboundedRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
});
