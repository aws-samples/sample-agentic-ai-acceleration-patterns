// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's CDK app (platform stress test, docs/stress-test.spec.md §3.1,
 * §3.6; `scripts/stress/slice.sh deploy`). Two stacks in the platform account:
 *
 * - `<prefix>-cp-setup`: a throwaway vendor IdP (a Cognito user pool whose pre token
 *   generation trigger puts `role: "operator"` on the ID token, ADR-018) and the script
 *   source: the repository at the pinned commit, as one zip in a private bucket, which the
 *   stress application's definition names (an S3 source, as the integration test uses).
 * - `<prefix>-control-plane`: the sample's `TenantStack`, fleet `<prefix in lower case>`,
 *   with `concurrentBuildLimit` from `STRESS_BUILD_LIMIT` (ADR-0046), and read on the source
 *   bucket for the cell and tenant projects. The fixed-name `/control-plane/tenant-api-url`
 *   parameter is left out, so the stress control plane never overwrites another one's.
 *
 * Environment: `STRESS_PREFIX`, `STRESS_BUILD_LIMIT`, `STRESS_SOURCE_ZIP` (the archive
 * slice.sh writes with `git archive`), `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`.
 */

import { App, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { stackNamesOf, parseBuildLimit } from './plan';
import { suppressTemplateScanners } from '../../src/shared/nag';
import { TenantStack } from '../../src/tenant/tenant.cdk';

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const names = stackNamesOf(need('STRESS_PREFIX'));
const buildLimit = parseBuildLimit(process.env.STRESS_BUILD_LIMIT);
const env = { account: need('CDK_DEFAULT_ACCOUNT'), region: need('CDK_DEFAULT_REGION') };
const app = new App();

const setup = new Stack(app, names.setup, { env, description: 'Platform stress test: the control-plane slice vendor IdP and script source (test asset)' });

const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
});
// ADR-018: the authorizer requires `role: "operator"`. A V1 trigger adds it to the ID token.
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  logGroup: new logs.LogGroup(setup, 'MintOperatorRoleLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      event.response = { claimsOverrideDetails: { claimsToAddOrOverride: { role: 'operator' } } };
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, mintOperatorRole);
// A verb's token lasts the verb: build-limit scaling and a teardown with cell deletes run
// past Cognito's one-hour default.
const operatorClient = vendorIdp.addClient('OperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
  idTokenValidity: Duration.hours(4),
  accessTokenValidity: Duration.hours(4),
});

const sourceBucket = new s3.Bucket(setup, 'Source', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
suppressTemplateScanners(sourceBucket, {
  cfnNag: [{ id: 'W35', reason: 'Stress-test script source, auto-deleted on teardown; access logging adds nothing to a test asset.' }],
  checkov: [
    { id: 'CKV_AWS_18', comment: 'Stress-test script source, auto-deleted on teardown; access logging adds nothing to a test asset.' },
    { id: 'CKV_AWS_21', comment: 'Stress-test script source, one object per commit; versioning adds nothing to a test asset.' },
  ],
});
const source = new s3deploy.BucketDeployment(setup, 'SourceZip', {
  destinationBucket: sourceBucket,
  destinationKeyPrefix: 'source/',
  sources: [s3deploy.Source.asset(need('STRESS_SOURCE_ZIP'))],
  extract: false,
  // One object per commit, and every one kept: a cell is stamped with the source it was
  // created from (control-plane ADR-0032), and its later tenant builds and its delete fetch
  // that object. The objects go with the bucket (`autoDeleteObjects`) on
  // `teardown --fixtures`, after every cell is deleted.
  prune: false,
  logGroup: new logs.LogGroup(setup, 'SourceZipLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
});

new CfnOutput(setup, 'UserPoolId', { value: vendorIdp.userPoolId });
new CfnOutput(setup, 'OperatorClientId', { value: operatorClient.userPoolClientId });
new CfnOutput(setup, 'SourceLocation', { value: `${sourceBucket.bucketName}/source/${Fn.select(0, source.objectKeys)}` });

const controlPlane = new TenantStack(app, names.controlPlane, {
  env,
  fleetName: names.fleet,
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: operatorClient.userPoolClientId,
  concurrentBuildLimit: buildLimit,
  description: 'Platform stress test: the control-plane slice control plane (test asset)',
});
controlPlane.node.tryRemoveChild('ApiUrlParameter');
// The source fetch runs under the build roles, before the buildspec assumes the role pair.
sourceBucket.grantRead(controlPlane.provisioning.cellProject);
sourceBucket.grantRead(controlPlane.provisioning.tenantProject);

app.synth();
