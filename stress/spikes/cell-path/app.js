// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Path spike: what a standalone cell account holds, and the probes.
// Run with NODE_PATH pointing at a sample's node_modules.
//
// Account-owner stacks (plain CloudFormation, legacy synthesizer: CLI credentials, inline template, no CDK
// bootstrap, as spec §3.7 requires):
// - CellPolicies-spike: the cell execution policy and permissions boundary.
// - CellAccountBase-spike: a stand-in for the role pair (a role on `/`,
//   trusted by the account, no boundary), the API Gateway CloudWatch Logs
//   role every runtime-isolation stage needs, and the identity parameters a
//   cell reads (context `userPoolId`, `appClientId`).
// Cell stacks (through the cell bootstrap, qualifier `cell`):
// - CellPathProbe-spike: a bounded `/cell/` role whose own policy allows
//   every escalation on `*`, so only the boundary can refuse (probes.sh).
// - CellPathDenyProbe-spike: a bounded role on `/`; its create must fail.
const path = require('node:path');
const { App, Aspects, CfnResource, LegacyStackSynthesizer, Stack } = require('aws-cdk-lib');
const { CfnInclude } = require('aws-cdk-lib/cloudformation-include');
const iam = require('aws-cdk-lib/aws-iam');
const ssm = require('aws-cdk-lib/aws-ssm');
const apigateway = require('aws-cdk-lib/aws-apigateway');

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const owner = { env, synthesizer: new LegacyStackSynthesizer() };

const policies = new Stack(app, 'CellPolicies-spike', owner);
new CfnInclude(policies, 'Policies', { templateFile: path.join(__dirname, 'cell-policies.yaml') });

const base = new Stack(app, 'CellAccountBase-spike', owner);
new iam.Role(base, 'RolePairStandIn', {
  roleName: 'cell-spike-role-pair-stand-in',
  assumedBy: new iam.AccountRootPrincipal(),
  description: 'Stand-in for the control-plane role pair: on /, no boundary',
});
const apiLogs = new iam.Role(base, 'ApiGatewayLogsRole', {
  assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')],
});
new apigateway.CfnAccount(base, 'ApiGatewayAccount', { cloudWatchRoleArn: apiLogs.roleArn });
const pool = app.node.tryGetContext('userPoolId');
const client = app.node.tryGetContext('appClientId');
if (pool && client) {
  new ssm.StringParameter(base, 'UserPoolId', { parameterName: '/application-plane/shared/identity/userPoolId', stringValue: pool });
  new ssm.StringParameter(base, 'AppClientId', { parameterName: '/application-plane/shared/identity/appClientId', stringValue: client });
}

/** Every AWS::IAM::Role on /cell/, CfnRole or raw CfnResource alike. */
class CellPath {
  visit(node) {
    if (CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::IAM::Role') {
      node.addPropertyOverride('Path', '/cell/');
    }
  }
}

const probe = new Stack(app, 'CellPathProbe-spike', { env });
const probeRole = new iam.Role(probe, 'ProbeRole', {
  roleName: 'cell-spike-probe',
  assumedBy: new iam.AccountRootPrincipal(),
  description: 'A compromised cell role: its own policy allows every escalation; the boundary must refuse',
});
probeRole.addToPolicy(new iam.PolicyStatement({
  actions: ['iam:*', 'sts:AssumeRole', 'lambda:CreateFunction', 'lambda:DeleteFunction', 'ssm:PutParameter', 'ssm:DeleteParameter'],
  resources: ['*'],
}));
new iam.Role(probe, 'PositiveControlRole', {
  roleName: 'cell-spike-positive',
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  description: 'A cell role the probe may change (positive control)',
});
Aspects.of(probe).add(new CellPath());

const deny = new Stack(app, 'CellPathDenyProbe-spike', { env });
new iam.Role(deny, 'RoleOnRootPath', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  description: 'A bounded role on /, which the boundary must refuse',
});
