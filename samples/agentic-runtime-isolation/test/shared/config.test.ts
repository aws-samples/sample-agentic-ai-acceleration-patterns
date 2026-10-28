// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ENV, readIngressConfig, readRegistryConfig, requireEnv } from '../../src/shared/config';

/** The construct writes these variables; the handlers read them back (one encoding, one file). */
describe('readIngressConfig', () => {
  const base = {
    [ENV.INGRESS]: 'api-gateway',
    [ENV.DISCOVERY_URL]: 'https://issuer.example/.well-known/openid-configuration',
    [ENV.ALLOWED_CLIENT_IDS]: 'c1, c2',
    [ENV.REGISTRY_PREFIX]: '/application-plane/shared/agent-runtime/',
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
      registry: { prefix: '/application-plane/shared/agent-runtime/', ttlSeconds: 60, defaultBackend: undefined },
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
      [ENV.REGISTRY_TTL_SECONDS]: '30',
      [ENV.DEFAULT_BACKEND]: 'agent',
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
    expect(config.registry).toEqual({ prefix: '/application-plane/shared/agent-runtime/', ttlSeconds: 30, defaultBackend: 'agent' });
  });

  it('registry (ADR-0024): the prefix is required and must be an absolute path ending in /; TTL defaults to 60; an empty default is none', () => {
    expect(readRegistryConfig({ [ENV.REGISTRY_PREFIX]: '/p/', [ENV.DEFAULT_BACKEND]: '' })).toEqual({ prefix: '/p/', ttlSeconds: 60, defaultBackend: undefined });
    expect(() => readIngressConfig({ ...base, [ENV.REGISTRY_PREFIX]: undefined })).toThrow(ENV.REGISTRY_PREFIX);
    expect(() => readIngressConfig({ ...base, [ENV.REGISTRY_PREFIX]: 'relative/' })).toThrow(ENV.REGISTRY_PREFIX);
    expect(() => readIngressConfig({ ...base, [ENV.REGISTRY_PREFIX]: '/no-trailing-slash' })).toThrow(ENV.REGISTRY_PREFIX);
    expect(() => readIngressConfig({ ...base, [ENV.REGISTRY_TTL_SECONDS]: '0' })).toThrow(ENV.REGISTRY_TTL_SECONDS);
    expect(() => readIngressConfig({ ...base, [ENV.REGISTRY_TTL_SECONDS]: 'soon' })).toThrow(ENV.REGISTRY_TTL_SECONDS);
  });

  it('registry: the default backend must be a valid backend name', () => {
    expect(readRegistryConfig({ ...base, [ENV.DEFAULT_BACKEND]: 'billing-2' }).defaultBackend).toBe('billing-2');
    for (const bad of ['Agent', 'a_b', 'a'.repeat(33), 'agent/invocations']) {
      expect(() => readRegistryConfig({ ...base, [ENV.DEFAULT_BACKEND]: bad })).toThrow(ENV.DEFAULT_BACKEND);
    }
  });

  it('registry: the Region is the Lambda\'s AWS_REGION and the account is RI_REGISTRY_ACCOUNT; either absent skips its check', () => {
    expect(readRegistryConfig({ ...base, AWS_REGION: 'eu-central-1', [ENV.REGISTRY_ACCOUNT]: '111122223333' })).toMatchObject({
      region: 'eu-central-1',
      account: '111122223333',
    });
    const none = readRegistryConfig({ ...base, AWS_REGION: '', [ENV.REGISTRY_ACCOUNT]: '' });
    expect(none.region).toBeUndefined();
    expect(none.account).toBeUndefined();
    expect(readIngressConfig({ ...base, AWS_REGION: 'us-east-1' }).registry.region).toBe('us-east-1');
    expect(() => readRegistryConfig({ ...base, [ENV.REGISTRY_ACCOUNT]: '12345' })).toThrow(ENV.REGISTRY_ACCOUNT);
    expect(() => readRegistryConfig({ ...base, [ENV.REGISTRY_ACCOUNT]: 'arn:aws:iam::111122223333:root' })).toThrow(ENV.REGISTRY_ACCOUNT);
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
