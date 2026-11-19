// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { testConfig } from './support';
import { loadConfig } from '../../src/registrar/config';
import { REGISTRAR_ENV } from '../../src/shared/contracts';

const base = testConfig();

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [REGISTRAR_ENV.routeTableArn]: base.routeTableArn,
    [REGISTRAR_ENV.appDomain]: base.appDomain,
    [REGISTRAR_ENV.addressing]: 'host',
    [REGISTRAR_ENV.applicationId]: base.applicationId,
    [REGISTRAR_ENV.controlPlaneUrl]: `${base.controlPlaneUrl}/`,
    [REGISTRAR_ENV.controlPlaneAccount]: base.controlPlaneAccount,
    [REGISTRAR_ENV.controlPlaneRegion]: base.controlPlaneRegion,
    [REGISTRAR_ENV.vendorIdpTokenUrl]: base.vendorIdpTokenUrl,
    [REGISTRAR_ENV.vendorIdpClientId]: base.vendorIdpClientId,
    [REGISTRAR_ENV.vendorIdpSecretArn]: base.vendorIdpSecretArn,
    [REGISTRAR_ENV.fleet]: base.fleet,
    [REGISTRAR_ENV.edgeOperatorRoleArn]: base.edgeOperatorRoleArn,
    [REGISTRAR_ENV.dedicatedDomains]: 'on',
    [REGISTRAR_ENV.distributionId]: 'E1EXAMPLE',
    ...overrides,
  };
}

describe('registrar configuration (REGISTRAR_ENV)', () => {
  test('reads every variable, trimming the control plane URL', () => {
    expect(loadConfig(env())).toEqual({ ...base, addressing: 'host', dedicatedDomains: true, distributionId: 'E1EXAMPLE' });
  });

  test('DISTRIBUTION_ID is optional', () => {
    expect(loadConfig(env({ [REGISTRAR_ENV.distributionId]: undefined, [REGISTRAR_ENV.dedicatedDomains]: 'off' })).distributionId).toBeUndefined();
  });

  test('DISTRIBUTION_ID is required while dedicated domains are on', () => {
    expect(() => loadConfig(env({ [REGISTRAR_ENV.distributionId]: undefined }))).toThrow(REGISTRAR_ENV.distributionId);
  });

  test.each(Object.values(REGISTRAR_ENV).filter((name) => name !== REGISTRAR_ENV.distributionId))('a missing %s fails closed', (name) => {
    expect(() => loadConfig(env({ [name]: undefined }))).toThrow(name);
  });

  test.each([
    [REGISTRAR_ENV.addressing, 'subdomain'],
    [REGISTRAR_ENV.dedicatedDomains, 'yes'],
    [REGISTRAR_ENV.controlPlaneAccount, '1234'],
    [REGISTRAR_ENV.controlPlaneRegion, 'Europe'],
    [REGISTRAR_ENV.controlPlaneUrl, 'http://cp.example.com'],
    [REGISTRAR_ENV.vendorIdpTokenUrl, 'not a url'],
    [REGISTRAR_ENV.appDomain, 'App.Example.com'],
    [REGISTRAR_ENV.applicationId, 'Demo App'],
    [REGISTRAR_ENV.edgeOperatorRoleArn, 'arn:aws:iam::123456789012:user/alice'],
    [REGISTRAR_ENV.edgeOperatorRoleArn, 'arn:aws:iam::123456789012:role/ops/'],
    [REGISTRAR_ENV.routeTableArn, 'kvs-1'],
  ])('a malformed %s fails closed', (name, value) => {
    expect(() => loadConfig(env({ [name]: value }))).toThrow(name);
  });
});
