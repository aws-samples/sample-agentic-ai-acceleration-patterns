// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ENV, readIngressConfig, requireEnv } from '../../src/shared/config';

/** The construct writes these variables; the handlers read them back (one encoding, one file). */
describe('readIngressConfig', () => {
  const base = {
    [ENV.INGRESS]: 'api-gateway',
    [ENV.DISCOVERY_URL]: 'https://issuer.example/.well-known/openid-configuration',
    [ENV.ALLOWED_CLIENT_IDS]: 'c1, c2',
  };

  it('reads the minimal configuration with every module off', () => {
    expect(readIngressConfig(base)).toEqual({
      ingress: 'api-gateway',
      discoveryUrl: 'https://issuer.example/.well-known/openid-configuration',
      allowedClientIds: ['c1', 'c2'],
      requiredScopes: undefined,
      sessionScope: undefined,
      delegation: { forwardUserToken: false, requireNarrowedToken: false, allowedScopes: undefined },
      tvm: undefined,
    });
  });

  it('reads every module', () => {
    const config = readIngressConfig({
      ...base,
      [ENV.INGRESS]: 'agentcore-gateway',
      [ENV.REQUIRED_SCOPES]: 'tenant-api/read',
      [ENV.SESSION_SCOPE]: 'tenant',
      [ENV.FORWARD_USER_TOKEN]: 'true',
      [ENV.REQUIRE_NARROWED_TOKEN]: 'true',
      [ENV.ALLOWED_SCOPES]: 'tenant-api/read',
      [ENV.TVM_ROLE_ARN]: 'arn:aws:iam::111122223333:role/tenant',
      [ENV.TVM_INCLUDE_USER_ID_TAG]: 'true',
      [ENV.TVM_CLAIM_TAGS]: '{"Tier":"custom:tier"}',
      [ENV.TVM_DURATION_SECONDS]: '1800',
    });
    expect(config.ingress).toBe('agentcore-gateway');
    expect(config.requiredScopes).toEqual(['tenant-api/read']);
    expect(config.sessionScope).toBe('tenant');
    expect(config.delegation).toEqual({ forwardUserToken: true, requireNarrowedToken: true, allowedScopes: ['tenant-api/read'] });
    expect(config.tvm).toEqual({ roleArn: 'arn:aws:iam::111122223333:role/tenant', includeUserIdTag: true, claimTags: { Tier: 'custom:tier' }, durationSeconds: 1800 });
  });

  it('fails at cold start naming the variable', () => {
    expect(() => readIngressConfig({ ...base, [ENV.INGRESS]: '' })).toThrow(ENV.INGRESS);
    expect(() => readIngressConfig({ ...base, [ENV.INGRESS]: 'other' })).toThrow(ENV.INGRESS);
    expect(() => readIngressConfig({ ...base, [ENV.DISCOVERY_URL]: undefined })).toThrow(ENV.DISCOVERY_URL);
    expect(() => readIngressConfig({ ...base, [ENV.SESSION_SCOPE]: 'global' })).toThrow(ENV.SESSION_SCOPE);
    expect(() => readIngressConfig({ ...base, [ENV.TVM_ROLE_ARN]: 'arn', [ENV.TVM_DURATION_SECONDS]: '60' })).toThrow(ENV.TVM_DURATION_SECONDS);
    expect(() => requireEnv('MISSING', {})).toThrow('MISSING');
  });
});
