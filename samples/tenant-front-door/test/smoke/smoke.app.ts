// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Smoke-test fixtures for `scripts/smoke.sh`: the parts of a deployment
 * the front door needs before the control plane's hooks exist (spec §10,
 * steps 1 to 10 and 13, without the control plane).
 *
 * - `TfdSmoke-support`: the edge operator role the front door names as
 *   `edgeOperatorRoleArn`, assumable from this account, and a placeholder
 *   vendor IdP client secret. The control plane the smoke names does not
 *   exist, so every registrar write that reads it answers 503.
 * - `TfdSmoke-cell`: one demo cell API, granted to the edge distribution
 *   named by the `distributionArn` context.
 *
 * Not part of the sample: nothing here is deployed by `src/main.ts`.
 */

import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DemoCellApi } from '../../src/demo-cell/demo-cell-api.cdk';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'eu-central-1';
const env = { account, region };

const OPERATOR_ROLE_NAME = 'tfd-smoke-edge-operator';

const support = new Stack(app, 'TfdSmoke-support', { env, description: 'tenant-front-door smoke test: edge operator role and placeholder IdP secret' });
const operator = new iam.Role(support, 'EdgeOperator', {
  roleName: OPERATOR_ROLE_NAME,
  assumedBy: new iam.AccountRootPrincipal(),
  description: 'tenant-front-door smoke test edge operator: calls the registrar',
});
operator.addToPolicy(new iam.PolicyStatement({
  actions: ['execute-api:Invoke'],
  resources: [support.formatArn({ service: 'execute-api', resource: '*' })],
}));
const secret = new secretsmanager.Secret(support, 'VendorIdpSecret', {
  description: 'tenant-front-door smoke test: placeholder vendor IdP client secret (no control plane exists)',
  generateSecretString: { passwordLength: 32, excludePunctuation: true },
});
new CfnOutput(support, 'EdgeOperatorRoleArn', { value: operator.roleArn });
new CfnOutput(support, 'VendorIdpSecretArn', { value: secret.secretArn });

const distributionArn = app.node.tryGetContext('distributionArn') as string | undefined;
if (distributionArn !== undefined) {
  const cell = new Stack(app, 'TfdSmoke-cell', { env, description: 'tenant-front-door smoke test: one demo cell API' });
  const issuer = required('cellIssuer');
  const api = new DemoCellApi(cell, 'CellApi', {
    issuer: { issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, clientIds: [required('cellClientId')] },
    applicationId: required('applicationId'),
    cellId: required('cellId'),
    distributionArn,
  });
  new CfnOutput(cell, 'ApiDomain', { value: api.apiDomain });
  new CfnOutput(cell, 'FunctionUrl', { value: api.functionUrl.url });
}

app.synth();

function required(key: string): string {
  const value = app.node.tryGetContext(key) as string | undefined;
  if (value === undefined || value === '') throw new Error(`Missing context '${key}'`);
  return value;
}
