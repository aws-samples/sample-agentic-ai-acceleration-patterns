// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { DynamoDBRegistry } from '../../src/shared/registry';

// Cold start reads TABLE_NAME via requireEnv at module load. `require` (not a
// static import) runs after this assignment; a static import is hoisted above it.
process.env.TABLE_NAME = 'registry-table';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPolicy, handler, verifierFor } = require('../../src/tenant-api/tenant-authorizer.function') as typeof import('../../src/tenant-api/tenant-authorizer.function');

/**
 * Unit tests for the authoriser handler's policy shape (ADR-0007, spec §5.3):
 * Allow carries the caller context; Deny is an explicit Deny with no context,
 * so API Gateway answers 403.
 */

const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123/prod/GET/tenant/users';

/** The IAM statement type is a union; read the first statement as a record. */
function firstStatement(result: { policyDocument: { Statement: unknown[] } }): Record<string, unknown> {
  return result.policyDocument.Statement[0] as Record<string, unknown>;
}

describe('buildPolicy (ADR-0007)', () => {
  it('Allow carries an Allow statement and {tenantId, sub} context', () => {
    const result = buildPolicy(METHOD_ARN, 'Allow', {
      tenantId: '01HZX9ABCDEFGHJKMNPQRSTVWX',
      sub: 'user-1',
      usageIdentifierKey: 'tenant-key-value-000000',
    });
    expect(result.principalId).toBe('user-1');
    expect(firstStatement(result)).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: METHOD_ARN,
    });
    expect(result.context).toEqual({ tenantId: '01HZX9ABCDEFGHJKMNPQRSTVWX', sub: 'user-1' });
    // ADR-0025: the tenant's key goes to API Gateway, never into the context.
    expect(result.usageIdentifierKey).toBe('tenant-key-value-000000');
  });

  it('Deny is an explicit Deny with no context (API Gateway → 403)', () => {
    const result = buildPolicy(METHOD_ARN, 'Deny');
    expect(result.principalId).toBe('unauthorized');
    expect(firstStatement(result).Effect).toBe('Deny');
    expect(firstStatement(result).Resource).toBe(METHOD_ARN);
    expect(result.context).toBeUndefined();
    // No key on Deny: nothing is throttled against a tenant.
    expect(result.usageIdentifierKey).toBeUndefined();
  });
});

describe('handler (ADR-0007)', () => {
  const event = (authorizationToken: string): APIGatewayTokenAuthorizerEvent => ({
    type: 'TOKEN',
    authorizationToken,
    methodArn: METHOD_ARN,
  });

  it('refuses a non-bearer header with an explicit Deny', async () => {
    const result = await handler(event('Basic nope'));
    expect(firstStatement(result).Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
  });

  it('a registry failure is an explicit Deny with no context, never an Allow (P-2)', async () => {
    // No shared pool is configured, so the handler takes the pool-per-tenant
    // path: the unverified issuer is mapped through the registry, which fails.
    const spy = jest
      .spyOn(DynamoDBRegistry.prototype, 'getByUserPoolId')
      .mockRejectedValue(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'RS256', kid: 'k' })}.${b64({ iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_pool1' })}.sig`;
    try {
      const result = await handler(event(`Bearer ${jwt}`));
      expect(spy).toHaveBeenCalledWith('eu-central-1_pool1');
      expect(result.principalId).toBe('unauthorized');
      expect(firstStatement(result).Effect).toBe('Deny');
      expect(result.context).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifierFor cache key (M-25)', () => {
  const POOL = 'eu-central-1_pool1';

  it('reuses one verifier for the same pool and client', () => {
    const first = verifierFor(POOL, 'client-a');
    const second = verifierFor(POOL, 'client-a');
    expect(second).toBe(first);
  });

  it('builds a distinct verifier for a different client id on the same pool', () => {
    // M-25: the cache is keyed by pool AND client, so a verifier built for
    // one app client is never handed back for another — a different client
    // id gets its own verifier bound to that client.
    const forA = verifierFor(POOL, 'client-a');
    const forB = verifierFor(POOL, 'client-b');
    expect(forB).not.toBe(forA);
  });
});
