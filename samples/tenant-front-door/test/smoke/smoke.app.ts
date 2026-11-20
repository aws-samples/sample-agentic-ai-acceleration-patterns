// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Smoke-test fixtures for `scripts/smoke.sh` and `scripts/smoke-domains.sh`:
 * the parts of a deployment the front door needs to run without the
 * control plane sample and its hooks (spec §10).
 *
 * - `TfdSmoke-support`: the edge operator role the front door names as
 *   `edgeOperatorRoleArn`, and a role named like the control plane's
 *   `<fleet>-global-hook` role, both assumable from this account.
 * - `TfdSmoke-control-plane`: a stand-in control plane. It answers the
 *   registrar's three reads from fixture items behind API Gateway with a
 *   Cognito authorizer, and its user pool issues the registrar's
 *   client-credentials reader token (ADR-0015).
 * - `TfdSmoke-cell`: one demo cell API, granted to the edge distribution
 *   named by the `distributionArn` context.
 * - `TfdSmoke-dns`: the DNS records a dedicated-domain run publishes, from
 *   the `dnsRecords` context.
 *
 * Not part of the sample: nothing here is deployed by `src/main.ts`.
 */

import * as path from 'node:path';
import { App, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DemoCellApi } from '../../src/demo-cell/demo-cell-api.cdk';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'eu-central-1';
const env = { account, region };

/** The smoke's `fleet` input: the registrar admits `<fleet>-global-hook` of the control plane's account. */
export const SMOKE_FLEET = 'tfd-smoke';

// --- Support: the two callers of the registrar ------------------------------

const support = new Stack(app, 'TfdSmoke-support', { env, description: 'tenant-front-door smoke test: edge operator and stand-in global hook roles' });
const registrarRoutes = (...routes: string[]) => routes.map((route) => support.formatArn({ service: 'execute-api', resource: route }));
// Both are assumed by the smoke driver's own identity in this account. The
// registrar's resource policy is the gate; these policies name only the
// registrar's routes, on any API, because its API id does not exist yet.
const operator = new iam.Role(support, 'EdgeOperator', {
  assumedBy: new iam.AccountRootPrincipal(),
  description: 'tenant-front-door smoke test edge operator: calls the registrar',
});
operator.addToPolicy(new iam.PolicyStatement({
  actions: ['execute-api:Invoke'],
  resources: registrarRoutes('*/*/PUT/cells/*', '*/*/PUT/tenants/*', '*/*/DELETE/cells/*', '*/*/DELETE/tenants/*', '*/*/DELETE/hosts/*'),
}));
const hook = new iam.Role(support, 'GlobalHook', {
  roleName: `${SMOKE_FLEET}-global-hook`,
  assumedBy: new iam.AccountRootPrincipal(),
  description: 'tenant-front-door smoke test: stands in for the control plane global hook role',
});
hook.addToPolicy(new iam.PolicyStatement({
  actions: ['execute-api:Invoke'],
  resources: registrarRoutes('*/*/PUT/cells/*', '*/*/PUT/tenants/*', '*/*/DELETE/cells/*', '*/*/DELETE/tenants/*'),
}));
new CfnOutput(support, 'EdgeOperatorRoleArn', { value: operator.roleArn });
new CfnOutput(support, 'GlobalHookRoleArn', { value: hook.roleArn });

// --- Stand-in control plane ---------------------------------------------------

const cp = new Stack(app, 'TfdSmoke-control-plane', { env, description: 'tenant-front-door smoke test: stand-in control plane for the registrar reads' });
const fixtures = new dynamodb.TableV2(cp, 'Fixtures', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  billing: dynamodb.Billing.onDemand(),
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  removalPolicy: RemovalPolicy.DESTROY, // test fixture
});
const reads = new NodejsFunction(cp, 'Reads', {
  entry: path.join(__dirname, 'control-plane.function.ts'),
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_24_X,
  architecture: lambda.Architecture.ARM_64,
  timeout: Duration.seconds(5),
  environment: { FIXTURE_TABLE: fixtures.tableName },
  bundling: { minify: true, sourceMap: false, externalModules: [] },
});
fixtures.grantReadData(reads);

const pool = new cognito.UserPool(cp, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY, // test fixture
});
const readScope = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read cells, tenants and deployments' });
const server = pool.addResourceServer('ControlPlane', { identifier: 'tfd-smoke-control-plane', scopes: [readScope] });
// A prefix CloudFormation makes unique per stack: the stack id's UUID.
const domain = pool.addDomain('Domain', {
  cognitoDomain: { domainPrefix: Fn.join('', ['tfd-smoke-', Fn.select(2, Fn.split('/', cp.stackId))]) },
});
const reader = pool.addClient('Registrar', {
  generateSecret: true,
  authFlows: {},
  oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(server, readScope)] },
});
const readerSecret = new secretsmanager.Secret(cp, 'ReaderSecret', {
  description: 'tenant-front-door smoke test: the registrar reader client secret of the stand-in control plane',
  secretStringValue: reader.userPoolClientSecret,
});

const api = new apigateway.RestApi(cp, 'Api', {
  description: 'tenant-front-door smoke test: stand-in control plane reads (Cognito client-credentials token)',
  deployOptions: { stageName: 'prod' },
});
const authorizer = new apigateway.CognitoUserPoolsAuthorizer(cp, 'Authorizer', { cognitoUserPools: [pool] });
api.root.addProxy({
  anyMethod: false,
}).addMethod('GET', new apigateway.LambdaIntegration(reads), {
  authorizationType: apigateway.AuthorizationType.COGNITO,
  authorizer,
  authorizationScopes: [`${server.userPoolResourceServerId}/${readScope.scopeName}`],
});
new CfnOutput(cp, 'ApiUrl', { value: api.url });
new CfnOutput(cp, 'TokenUrl', { value: `${domain.baseUrl()}/oauth2/token` });
new CfnOutput(cp, 'ClientId', { value: reader.userPoolClientId });
new CfnOutput(cp, 'ClientSecretArn', { value: readerSecret.secretArn });
new CfnOutput(cp, 'FixtureTable', { value: fixtures.tableName });

// --- Demo cell -----------------------------------------------------------------

const distributionArn = app.node.tryGetContext('distributionArn') as string | undefined;
if (distributionArn !== undefined) {
  const cell = new Stack(app, 'TfdSmoke-cell', { env, description: 'tenant-front-door smoke test: one demo cell API' });
  const issuer = required('cellIssuer');
  const cellApi = new DemoCellApi(cell, 'CellApi', {
    issuer: { issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, clientIds: [required('cellClientId')] },
    applicationId: required('applicationId'),
    cellId: required('cellId'),
    distributionArn,
  });
  new CfnOutput(cell, 'ApiDomain', { value: cellApi.apiDomain });
  new CfnOutput(cell, 'FunctionUrl', { value: cellApi.functionUrl.url });
}

// --- Dedicated-domain DNS records -------------------------------------------

interface DnsRecordInput {
  readonly name: string;
  readonly type: 'TXT' | 'CNAME';
  readonly value: string;
}
const dnsRecords = app.node.tryGetContext('dnsRecords') as string | undefined;
if (dnsRecords !== undefined) {
  const dns = new Stack(app, 'TfdSmoke-dns', { env, description: 'tenant-front-door smoke test: dedicated-domain DNS records' });
  const zoneId = required('zoneId');
  (JSON.parse(dnsRecords) as DnsRecordInput[]).forEach((r, i) => {
    new route53.CfnRecordSet(dns, `Record${i}`, {
      hostedZoneId: zoneId,
      name: r.name,
      type: r.type,
      ttl: '60',
      resourceRecords: [r.type === 'TXT' ? `"${r.value}"` : r.value],
    });
  });
}

app.synth();

function required(key: string): string {
  const value = app.node.tryGetContext(key) as string | undefined;
  if (value === undefined || value === '') throw new Error(`Missing context '${key}'`);
  return value;
}
