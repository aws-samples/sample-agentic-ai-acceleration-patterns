// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';

// Cold start reads TABLE_NAME via requireEnv at module load. `require` (not a
// static import) runs after this assignment; a static import is hoisted above it.
process.env.TABLE_NAME = 'registry-table';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPolicy, handler } = require('../../src/tenant-api/tenant-authorizer.function') as typeof import('../../src/tenant-api/tenant-authorizer.function');

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
    const result = buildPolicy(METHOD_ARN, 'Allow', { tenantId: '01HZX9ABCDEFGHJKMNPQRSTVWX', sub: 'user-1' });
    expect(result.principalId).toBe('user-1');
    expect(firstStatement(result)).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: METHOD_ARN,
    });
    expect(result.context).toEqual({ tenantId: '01HZX9ABCDEFGHJKMNPQRSTVWX', sub: 'user-1' });
  });

  it('Deny is an explicit Deny with no context (API Gateway → 403)', () => {
    const result = buildPolicy(METHOD_ARN, 'Deny');
    expect(result.principalId).toBe('unauthorized');
    expect(firstStatement(result).Effect).toBe('Deny');
    expect(firstStatement(result).Resource).toBe(METHOD_ARN);
    expect(result.context).toBeUndefined();
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
});
