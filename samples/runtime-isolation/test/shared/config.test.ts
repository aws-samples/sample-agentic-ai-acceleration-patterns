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
      limits: undefined,
      perTenantMetrics: false,
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
      [ENV.TVM_CACHE_MAX_ENTRIES]: '50',
      [ENV.LIMITS_TABLE]: 'TenantLimits',
      [ENV.LIMIT_REQUESTS_PER_MINUTE]: '60',
      [ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]: '5000',
      [ENV.PER_TENANT_METRICS]: 'true',
    });
    expect(config.ingress).toBe('agentcore-gateway');
    expect(config.requiredScopes).toEqual(['tenant-api/read']);
    expect(config.sessionScope).toBe('tenant');
    expect(config.delegation).toEqual({ forwardUserToken: true, requireNarrowedToken: true, allowedScopes: ['tenant-api/read'] });
    expect(config.tvm).toEqual({
      roleArn: 'arn:aws:iam::111122223333:role/tenant',
      includeUserIdTag: true,
      claimTags: { Tier: 'custom:tier' },
      durationSeconds: 1800,
      cacheMaxEntries: 50,
    });
    expect(config.limits).toEqual({ tableName: 'TenantLimits', requestsPerMinute: 60, outputTokensPerMinute: 5000 });
    expect(config.perTenantMetrics).toBe(true);
  });

  it('limits: a table with no request limit reads as 0 and no token limit', () => {
    expect(readIngressConfig({ ...base, [ENV.LIMITS_TABLE]: 'TenantLimits' }).limits).toEqual({
      tableName: 'TenantLimits',
      requestsPerMinute: 0,
      outputTokensPerMinute: undefined,
    });
    expect(readIngressConfig({ ...base, [ENV.LIMITS_TABLE]: '' }).limits).toBeUndefined();
  });

  it('rejects malformed limit and cache numbers, naming the variable', () => {
    const limits = { ...base, [ENV.LIMITS_TABLE]: 'TenantLimits' };
    expect(() => readIngressConfig({ ...limits, [ENV.LIMIT_REQUESTS_PER_MINUTE]: '-1' })).toThrow(ENV.LIMIT_REQUESTS_PER_MINUTE);
    expect(() => readIngressConfig({ ...limits, [ENV.LIMIT_REQUESTS_PER_MINUTE]: '1.5' })).toThrow(ENV.LIMIT_REQUESTS_PER_MINUTE);
    expect(() => readIngressConfig({ ...limits, [ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE]: '0' })).toThrow(ENV.LIMIT_OUTPUT_TOKENS_PER_MINUTE);
    expect(() =>
      readIngressConfig({ ...base, [ENV.TVM_ROLE_ARN]: 'arn:aws:iam::111122223333:role/t', [ENV.TVM_CACHE_MAX_ENTRIES]: '0' }),
    ).toThrow(ENV.TVM_CACHE_MAX_ENTRIES);
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
