// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TenantFrontDoor, TenantFrontDoorProps } from './index';

/**
 * The sample app: one `TenantFrontDoor` from the spec §3.6 inputs, given as
 * CDK context (`cdk.json` or `--context`). Structured inputs take JSON:
 *
 *   npx cdk deploy --all \
 *     --context appDomain=app.example.com \
 *     --context hostedZone='{"zoneId":"Z...","zoneName":"example.com"}' \
 *     --context applicationId=my-app \
 *     --context controlPlane='{"apiUrl":"https://...","accountId":"...","region":"eu-central-1",
 *                              "vendorIdp":{"tokenUrl":"https://...","clientId":"...","clientSecretArn":"arn:..."}}' \
 *     --context fleet=control-plane \
 *     --context edgeOperatorRoleArn=arn:aws:iam::<edge account>:role/<name> \
 *     --context issuer='{"clientId":"...","scopes":"openid","cognitoDomain":"https://<domain>"}'
 *
 * Every input is validated at synth (spec §3.6). The stacks deploy in order:
 * edge, main, edge logging (ADR-0010).
 */
const app = new App();

// Security linting at synth: findings fail synthesis, and every
// acknowledgement carries its reason into the templates.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }));

const props: TenantFrontDoorProps = {
  appDomain: required('appDomain'),
  hostedZone: required('hostedZone', true),
  addressing: optional('addressing'),
  applicationId: required('applicationId'),
  controlPlane: required('controlPlane', true),
  fleet: required('fleet'),
  edgeOperatorRoleArn: required('edgeOperatorRoleArn'),
  issuer: required('issuer', true),
  signinKeys: optional('signinKeys', true),
  tenantClaim: optional('tenantClaim'),
  spaSource: optional('spaSource'),
  agentIngress: optional('agentIngress'),
  dedicatedDomains: optional('dedicatedDomains', true),
  tenantRequestsPer5Min: optional('tenantRequestsPer5Min', true),
  ipRequestsPer5Min: optional('ipRequestsPer5Min', true),
  reportingEndpoint: optional('reportingEndpoint'),
  alarmTopicArn: optional('alarmTopicArn'),
  // Seams to the router (build slice S1) and the registrar (S3): their
  // defaults are src/router/router.js and src/registrar/registrar.function.ts.
  routerSourcePath: optional('routerSourcePath'),
  registrarEntry: optional('registrarEntry'),
};

new TenantFrontDoor(app, 'TenantFrontDoor', props);

app.synth();

/** Fails synthesis with the input's name when it is missing. */
function required<T>(key: string, json = false): T {
  const value = optional<T>(key, json);
  if (value === undefined) {
    throw new Error(`Missing required CDK context '${key}' (spec §3.6). See the usage at the top of src/main.ts.`);
  }
  return value;
}

/**
 * Reads a context value. A structured input (`json`) given as a string, as
 * `--context` gives it, is parsed, so `--context hostedZone='{...}'` and a
 * cdk.json object arrive the same. The inputs' own checks follow.
 */
function optional<T>(key: string, json = false): T | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined || value === '') {
    return undefined;
  }
  if (json && typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new Error(`The ${key} context value is not valid JSON: ${(error as Error).message}`);
    }
  }
  return value as T;
}
