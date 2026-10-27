// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { ENV } from '../../src/shared/config';
import { CLIENT_ID, DISCOVERY_URL, testIssuer, type TestIssuer } from '../helpers';

process.env[ENV.INGRESS] = 'api-gateway';
process.env[ENV.DISCOVERY_URL] = DISCOVERY_URL;
process.env[ENV.ALLOWED_CLIENT_IDS] = CLIENT_ID;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const authorizer = require('../../src/ingress/api-gateway-authorizer.function') as typeof import('../../src/ingress/api-gateway-authorizer.function');

/** The Lambda authoriser (spec C-3a): Allow with {tenantId, sub} context, explicit Deny otherwise. */
const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123/prod/POST/invocations';

describe('buildPolicy', () => {
  it('Allow carries the verified tenant as context for the access log (P-9)', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Allow', { tenantId: 'tenant-a', sub: 'user-a1' });
    expect(result.principalId).toBe('user-a1');
    expect(result.policyDocument.Statement[0]).toEqual({ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN });
    expect(result.context).toEqual({ tenantId: 'tenant-a', sub: 'user-a1' });
  });

  it('Deny carries no context', () => {
    const result = authorizer.buildPolicy(METHOD_ARN, 'Deny');
    expect(result.principalId).toBe('unauthorized');
    expect((result.policyDocument.Statement[0] as any).Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
  });
});

describe('handler', () => {
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await testIssuer();
  });

  const event = (headers: Record<string, string>): APIGatewayRequestAuthorizerEvent =>
    ({ type: 'REQUEST', methodArn: METHOD_ARN, headers }) as unknown as APIGatewayRequestAuthorizerEvent;

  it('denies with no network: the real verifier cannot reach the synthetic issuer', async () => {
    // The module-level verifier fetches the discovery URL; with no reachable
    // issuer every token is refused with an explicit Deny, never an Allow.
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const result = await authorizer.handler(event({ Authorization: `Bearer ${await issuer.mint()}` }));
      expect((result.policyDocument.Statement[0] as any).Effect).toBe('Deny');
      expect(result.context).toBeUndefined();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('denies a missing or non-bearer header without consulting the issuer', async () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      for (const headers of [{}, { Authorization: 'Basic x' }] as Record<string, string>[]) {
        const result = await authorizer.handler(event(headers));
        expect((result.policyDocument.Statement[0] as any).Effect).toBe('Deny');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(spy.mock.calls[0][0]).reason).toBe('missing_token');
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
