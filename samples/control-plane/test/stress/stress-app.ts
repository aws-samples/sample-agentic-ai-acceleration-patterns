// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane slice's CDK app (platform stress test, docs/stress-test.spec.md §3.1,
 * §3.6; `scripts/stress/slice.sh deploy`). Two stacks in the platform account:
 *
 * - `<prefix>-cp-setup`: a throwaway vendor IdP (a Cognito user pool whose pre token
 *   generation trigger puts `role: "operator"` on the ID token, ADR-018, and
 *   `role: "control-plane:reader"` on the client-credentials token of the route registrar's
 *   reader client, R-38, ADR-043: the front door's registrar reads the control plane with it)
 *   and the script source: the repository at the pinned commit, as one zip in a private bucket, which the
 *   stress application's definition names (an S3 source, as the integration test uses).
 * - `<prefix>-control-plane`: the sample's `TenantStack`, fleet `<prefix in lower case>`,
 *   with `concurrentBuildLimit` from `STRESS_BUILD_LIMIT` (ADR-0046), and read on the source
 *   bucket for the cell and tenant projects. The fixed-name `/control-plane/tenant-api-url`
 *   parameter is left out, so the stress control plane never overwrites another one's.
 *
 * Environment: `STRESS_PREFIX`, `STRESS_BUILD_LIMIT`, `STRESS_SOURCE_ZIP` (the archive
 * slice.sh writes with `git archive`), `STRESS_HOOK_POLICY_ARNS` (optional, comma-separated:
 * the customer-managed policies of the front door's `RouteHookAccess`, which the control
 * plane's global hook role takes, R-41; the platform run's `hooks` step sets it),
 * `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`.
 */

import { App, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { stackNamesOf, parseBuildLimit } from './plan';
import { suppressTemplateScanners } from '../../src/shared/nag';
import { TenantStack } from '../../src/tenant/tenant.cdk';

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const names = stackNamesOf(need('STRESS_PREFIX'));
/** The role value of the registrar's reader token; `readerRoles` of the control plane lists it. */
const READER_ROLE = 'control-plane:reader';
/** The resource-server scope that binds that token to this API (R-38 `vendorIdpRequiredScope`). */
const READ_SCOPE = 'control-plane/read';
const hookPolicyArns = (process.env.STRESS_HOOK_POLICY_ARNS ?? '').split(',').filter((a) => a !== '');
const buildLimit = parseBuildLimit(process.env.STRESS_BUILD_LIMIT);
const env = { account: need('CDK_DEFAULT_ACCOUNT'), region: need('CDK_DEFAULT_REGION') };
const app = new App();

const setup = new Stack(app, names.setup, { env, description: 'Platform stress test: the control-plane slice vendor IdP and script source (test asset)' });

const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
  // R-38: a V3 trigger is the only way to add `role` to a client-credentials access token, and it needs the Essentials feature plan.
  featurePlan: cognito.FeaturePlan.ESSENTIALS,
});
// ADR-018: the authorizer requires `role: "operator"` on a user's ID token; R-38: the registrar's
// client-credentials access token carries no user, so the trigger branches on its source and gives
// it the reader role `readerRoles` lists (the twelve GET operations only, R-36).
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  logGroup: new logs.LogGroup(setup, 'MintOperatorRoleLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      if (event.triggerSource === 'TokenGeneration_ClientCredentials') {
        event.response = { claimsAndScopeOverrideDetails: { accessTokenGeneration: { claimsToAddOrOverride: { role: '${READER_ROLE}' } } } };
      } else {
        event.response = { claimsAndScopeOverrideDetails: { idTokenGeneration: { claimsToAddOrOverride: { role: 'operator' } } } };
      }
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, mintOperatorRole, cognito.LambdaVersion.V3_0);
// A verb's token lasts the verb: build-limit scaling and a teardown with cell deletes run
// past Cognito's one-hour default.
const operatorClient = vendorIdp.addClient('OperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
  idTokenValidity: Duration.hours(4),
  accessTokenValidity: Duration.hours(4),
});

// The front door's route registrar reads the control plane with a client-credentials token of
// this client (front-door ADR-0015). Cognito runs that flow only at a domain's token endpoint
// and refuses a client without a custom scope. A domain prefix is unique per Region across
// accounts: the fleet name separates runs, the account id separates accounts.
const domain = vendorIdp.addDomain('VendorIdpDomain', { cognitoDomain: { domainPrefix: `${names.fleet}-${env.account}` } });
const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read the stress control plane' });
const apiResource = vendorIdp.addResourceServer('ControlPlaneResource', { identifier: 'control-plane', scopes: [readScope] });
const registrarClient = vendorIdp.addClient('RegistrarReaderClient', {
  generateSecret: true,
  authFlows: {},
  oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(apiResource, readScope)] },
});
const registrarSecret = new secretsmanager.Secret(setup, 'RegistrarReaderSecret', {
  description: 'Platform stress test: the route registrar reader client secret',
  secretStringValue: registrarClient.userPoolClientSecret,
  removalPolicy: RemovalPolicy.DESTROY,
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
new CfnOutput(setup, 'RegistrarTokenUrl', { value: `${domain.baseUrl()}/oauth2/token` });
new CfnOutput(setup, 'RegistrarClientId', { value: registrarClient.userPoolClientId });
new CfnOutput(setup, 'RegistrarSecretArn', { value: registrarSecret.secretArn });
new CfnOutput(setup, 'SourceLocation', { value: `${sourceBucket.bucketName}/source/${Fn.select(0, source.objectKeys)}` });

const controlPlane = new TenantStack(app, names.controlPlane, {
  env,
  fleetName: names.fleet,
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: operatorClient.userPoolClientId,
  concurrentBuildLimit: buildLimit,
  // R-38, R-36: the registrar's reader client, bound to this API's read scope; the role value it gets maps to the reader grant.
  vendorIdpClientIds: [registrarClient.userPoolClientId],
  vendorIdpRequiredScope: READ_SCOPE,
  readerRoles: [READER_ROLE],
  // R-41: the front door's RouteHookAccess policy, once the platform run has deployed it.
  ...(hookPolicyArns.length === 0 ? {} : { globalHookManagedPolicyArns: hookPolicyArns }),
  description: 'Platform stress test: the control-plane slice control plane (test asset)',
});
// The fixed-name /control-plane/tenant-api-url parameter would overwrite another control plane's.
if (!controlPlane.node.tryRemoveChild('ApiUrlParameter')) throw new Error('TenantStack has no ApiUrlParameter to remove');
// The source fetch runs under the build roles, before the buildspec assumes the role pair.
sourceBucket.grantRead(controlPlane.provisioning.cellProject);
sourceBucket.grantRead(controlPlane.provisioning.tenantProject);

app.synth();
