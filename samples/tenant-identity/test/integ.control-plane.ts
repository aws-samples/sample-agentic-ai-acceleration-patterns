// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Control-plane mounting integration test app (mounting spec §10,
 * docs/sample-standard.md §5.2). This is the reference implementation for
 * wiring control-plane to tenant-identity.
 *
 * Two stacks, deployed together by `scripts/integ-control-plane.sh`:
 *
 *   - `TenantIdentity-shared-pool`: the identity deployment, publishing the
 *     shared parameters (`/application-plane/shared/identity/*`) the mount
 *     scripts and control-plane read. One topology is enough; per-topology
 *     behaviour is `integ.identity.ts`.
 *   - `TenantIdentityCpSetup`: what a real deployer brings and this test has
 *     to fake. A throwaway vendor IdP (Cognito pool + pre token generation
 *     trigger minting `role: operator`, as control-plane's own integ does)
 *     and an S3 bucket holding `scripts/control-plane/` as the source the
 *     control-plane CodeBuild projects fetch.
 *
 * control-plane itself is NOT in this app. The script deploys it through its
 * own deploy path (`cd ../control-plane && npx cdk deploy`) with the §3.4
 * context, so this test never imports control-plane code.
 */

import * as path from 'path';
import { App, CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { TenantIdentityStack } from '../src/identity.cdk';

/** The control-plane stack name its `src/main.ts` deploys. */
const CONTROL_PLANE_STACK = 'control-plane-dev';

const app = new App();

new TenantIdentityStack(app, 'TenantIdentity-shared-pool', {
  topology: 'shared-pool',
  publishSharedParameters: true,
});

const setup = new Stack(app, 'TenantIdentityCpSetup');

// --- Vendor IdP --------------------------------------------------------------
// control-plane ADR-018: operator tokens must carry `role: "operator"`. A
// plain Cognito ID token has no such claim; this trigger adds it.
const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
});
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      event.response = { claimsOverrideDetails: { claimsToAddOrOverride: { role: 'operator' } } };
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, mintOperatorRole);
const operatorClient = vendorIdp.addClient('OperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
});

// --- Script source -----------------------------------------------------------
const scripts = new s3.Bucket(setup, 'MountScripts', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
// The control-plane cell and tenant build roles do not exist yet (control-
// plane deploys after this stack), so the bucket names them by ARN pattern.
// Same account only.
scripts.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'ControlPlaneBuildsReadScripts',
  principals: [new iam.AnyPrincipal()],
  actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:ListBucket'],
  resources: [scripts.bucketArn, scripts.arnForObjects('*')],
  conditions: {
    StringEquals: { 'aws:PrincipalAccount': setup.account },
    ArnLike: { 'aws:PrincipalArn': `arn:${setup.partition}:iam::${setup.account}:role/${CONTROL_PLANE_STACK}-*` },
  },
}));
new s3deploy.BucketDeployment(setup, 'DeployMountScripts', {
  destinationBucket: scripts,
  destinationKeyPrefix: 'scripts/control-plane',
  sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts/control-plane'))],
});

new CfnOutput(setup, 'VendorIdpIssuerUrl', { value: vendorIdp.userPoolProviderUrl });
new CfnOutput(setup, 'VendorIdpPoolId', { value: vendorIdp.userPoolId });
new CfnOutput(setup, 'VendorIdpAudience', { value: operatorClient.userPoolClientId });
new CfnOutput(setup, 'ScriptSourceLocation', { value: `${scripts.bucketName}/scripts/` });

app.synth();
