// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * An account prerequisite of the integration test (spec §6.1): API Gateway
 * writes a stage's access log only when the account's API Gateway settings
 * in that Region name an IAM role it can assume. This app sets that role,
 * once per account and Region, for an account that has none or whose role
 * was deleted. The driver's preflight refuses to start without it.
 *
 *   npx cdk deploy --app 'npx ts-node -P test/tsconfig.json test/integ/api-gateway-account.app.ts' \
 *     TfdIntegApiGatewayAccount --region <Region>
 *
 * The role is kept when the stack is removed (RemovalPolicy.RETAIN), unlike
 * the sample's own resources (Sample Standard §4.3): it is an account
 * setting other API Gateway stages in the Region use too, and CloudFormation
 * leaves the account setting naming it, so deleting it would break access
 * logging in that Region, the case the preflight refuses. Delete the role
 * by hand only after pointing the setting at another role.
 */

import { App, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));
const stack = new Stack(app, 'TfdIntegApiGatewayAccount', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'API Gateway CloudWatch Logs role for this account and Region (tenant-front-door integration test prerequisite)',
});
const role = new iam.Role(stack, 'Role', {
  assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')],
  description: 'Lets API Gateway write access and execution logs in this account and Region',
});
role.applyRemovalPolicy(RemovalPolicy.RETAIN);
new apigateway.CfnAccount(stack, 'Account', { cloudWatchRoleArn: role.roleArn });
Validations.of(role).acknowledge({
  id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
  reason: 'The AWS managed policy API Gateway documents for its account logging role; it grants only CloudWatch Logs writes (spec §6.1).',
});
app.synth();
