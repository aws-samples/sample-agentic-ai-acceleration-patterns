// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { EDGE_ACCOUNT, restEvent, testConfig } from './support';
import { REGISTRAR_ENV } from '../../src/shared/contracts';

describe('the Lambda entry', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
  });

  test('builds its clients from REGISTRAR_ENV on the first call and refuses a caller it does not admit', async () => {
    const c = testConfig();
    Object.assign(process.env, {
      [REGISTRAR_ENV.routeTableArn]: c.routeTableArn,
      [REGISTRAR_ENV.appDomain]: c.appDomain,
      [REGISTRAR_ENV.addressing]: c.addressing,
      [REGISTRAR_ENV.applicationId]: c.applicationId,
      [REGISTRAR_ENV.controlPlaneUrl]: c.controlPlaneUrl,
      [REGISTRAR_ENV.controlPlaneAccount]: c.controlPlaneAccount,
      [REGISTRAR_ENV.controlPlaneRegion]: c.controlPlaneRegion,
      [REGISTRAR_ENV.vendorIdpTokenUrl]: c.vendorIdpTokenUrl,
      [REGISTRAR_ENV.vendorIdpClientId]: c.vendorIdpClientId,
      [REGISTRAR_ENV.vendorIdpSecretArn]: c.vendorIdpSecretArn,
      [REGISTRAR_ENV.fleet]: c.fleet,
      [REGISTRAR_ENV.edgeOperatorRoleArn]: c.edgeOperatorRoleArn,
      [REGISTRAR_ENV.dedicatedDomains]: 'off',
      AWS_REGION: 'eu-central-1',
    });
    const log = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { handler } = await import('../../src/registrar/registrar.function');
    const res = await handler(restEvent('DELETE', '/cells/01HZX8K9P0QRST7VWXYZ1A2B3D', {
      userArn: `arn:aws:sts::${EDGE_ACCOUNT}:assumed-role/Admin/s`,
      accountId: EDGE_ACCOUNT,
    }));
    expect(res.statusCode).toBe(403);
    log.mockRestore();
  });

  test('SDK calls time out with an error, not a warning, and try twice', async () => {
    const { SDK_CLIENT } = await import('../../src/registrar/registrar.function');
    expect(SDK_CLIENT.maxAttempts).toBe(2);
    const config = (SDK_CLIENT.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> }).configProvider;
    await expect(config).resolves.toMatchObject({ connectionTimeout: 2_000, requestTimeout: 3_000, throwOnRequestTimeout: true });
  });

  test('fails closed when the environment is incomplete', async () => {
    delete process.env[REGISTRAR_ENV.routeTableArn];
    const { handler } = await import('../../src/registrar/registrar.function');
    await expect(handler(restEvent('DELETE', '/cells/01HZX8K9P0QRST7VWXYZ1A2B3D', 'operator'))).rejects.toThrow(/is not set/);
  });

  test('uses the AWS seam, with ACM in us-east-1, only when dedicatedDomains is on', async () => {
    const { dedicatedDomainsFor } = await import('../../src/registrar/registrar.function');
    const { AwsDedicatedDomains, DedicatedDomainsOff } = await import('../../src/registrar/dedicated-domains');
    expect(dedicatedDomainsFor(testConfig())).toBeInstanceOf(DedicatedDomainsOff);
    const on = dedicatedDomainsFor(testConfig({ dedicatedDomains: true, distributionId: 'E1EXAMPLE2DIST' }));
    expect(on).toBeInstanceOf(AwsDedicatedDomains);
    const acm = (on as unknown as { options: { acm: { config: { region: () => Promise<string> } } } }).options.acm;
    await expect(acm.config.region()).resolves.toBe('us-east-1');
  });
});
