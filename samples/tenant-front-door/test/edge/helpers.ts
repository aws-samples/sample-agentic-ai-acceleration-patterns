// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'node:path';
import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TenantFrontDoor, TenantFrontDoorProps } from '../../src/edge/tenant-front-door.cdk';

export const FIXTURES = path.join(__dirname, 'fixtures');
export const EDGE_ACCOUNT = '111111111111';
export const CONTROL_PLANE_ACCOUNT = '222222222222';
export const OPERATOR_ROLE_ARN = `arn:aws:iam::${EDGE_ACCOUNT}:role/edge-operator`;

/** `single` mode with every required input and no optional one. */
export const BASE_PROPS: TenantFrontDoorProps = {
  appDomain: 'app.example.com',
  hostedZone: { zoneId: 'Z0123456789EXAMPLE', zoneName: 'example.com' },
  applicationId: 'demo-app',
  controlPlane: {
    apiUrl: 'https://control-plane.example.com/prod',
    accountId: CONTROL_PLANE_ACCOUNT,
    region: 'eu-central-1',
    vendorIdp: {
      tokenUrl: 'https://vendor.auth.example.com/oauth2/token',
      clientId: 'registrar-client',
      clientSecretArn: `arn:aws:secretsmanager:eu-central-1:${EDGE_ACCOUNT}:secret:registrar-client-AbCdEf`,
    },
  },
  fleet: 'demo-fleet',
  edgeOperatorRoleArn: OPERATOR_ROLE_ARN,
  issuer: { clientId: 'spa-client', scopes: ['openid', 'email'], cognitoDomain: 'https://login.auth.example.com' },
  spaSource: path.join(FIXTURES, 'spa'),
  routerSourcePath: path.join(FIXTURES, 'router-stub.js'),
  registrarEntry: path.join(FIXTURES, 'registrar-stub.function.ts'),
};

/** `host` mode with every optional input set. */
export const FULL_HOST_PROPS: TenantFrontDoorProps = {
  ...BASE_PROPS,
  addressing: 'host',
  signinKeys: { ids: ['k1', 'k2'], current: 'k2' },
  tenantClaim: 'custom:tenant',
  agentIngress: 'https://ingress.example.com/prod',
  tenantRequestsPer5Min: 3000,
  ipRequestsPer5Min: 600,
  reportingEndpoint: 'https://reports.example.com/csp',
  alarmTopicArn: `arn:aws:sns:eu-central-1:${EDGE_ACCOUNT}:front-door-alarms`,
  issuer: {
    ...BASE_PROPS.issuer,
    exchangeEndpoint: 'https://exchange.example.com/oauth2/token',
  },
};

export interface Synth {
  readonly frontDoor: TenantFrontDoor;
  readonly edge: Template;
  readonly main: Template;
  readonly logging: Template;
}

/** Synthesises the three stacks, bundling skipped, optionally with cdk-nag. */
export function synth(props: TenantFrontDoorProps = BASE_PROPS, withNag = false): Synth {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (withNag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const frontDoor = new TenantFrontDoor(app, 'Tfd', props);
  return {
    frontDoor,
    edge: Template.fromStack(frontDoor.edgeStack),
    main: Template.fromStack(frontDoor.mainStack),
    logging: Template.fromStack(frontDoor.edgeLoggingStack),
  };
}

/** The one resource of a type in a template, its properties. */
export function only(template: Template, type: string): Record<string, any> {
  const found = Object.values(template.findResources(type));
  if (found.length !== 1) {
    throw new Error(`expected one ${type}, found ${found.length}`);
  }
  return found[0].Properties;
}
