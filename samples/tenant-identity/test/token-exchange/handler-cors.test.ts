// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token-exchange entry with an `allowedOrigins` list (spec §5.4.1,
 * ADR-0040): the CORS headers reach the 200, an OAuth error, a
 * `server_error` and a framework error alike. Its own file because the
 * list is read once at module load.
 */

import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { AwsStub, mockClient } from 'aws-sdk-client-mock';
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  SCOPE_PARTITION_KEY,
  TENANT_RESOURCE_PREFIX,
  TOKEN_TYPE_REFRESH,
} from '../../src/shared/constants';

const SCOPE = 'sample/read';
const LISTED = 'https://app.example.com';
const TENANT_HOST = 'https://acme.tenants.example.com';

process.env.TOPOLOGY = 'pool-per-tenant';
process.env.TABLE_NAME = 'registry';
process.env.POOL_INDEX_NAME = 'byUserPoolId';
process.env.ALLOWED_ORIGINS = `${LISTED},https://*.tenants.example.com`;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../src/token-exchange/token-exchange.function') as typeof import('../../src/token-exchange/token-exchange.function');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamoMock: any = mockClient(DynamoDBDocumentClient as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Query = QueryCommand as any;
const cognitoMock = mockClient(CognitoIdentityProviderClient as never) as unknown as AwsStub<any, any, any>;
const GetTokens = GetTokensFromRefreshTokenCommand as unknown as new (input: unknown) => any;

const TENANT_A = '01HZX8K9P0QRST7VWXYZ1A2B3C';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}
const ACCESS = fakeJwt({ token_use: 'access', tenant_id: TENANT_A, scope: SCOPE, sub: 'user-1' });

function formBody(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: 'app-client-id',
    subject_token: 'refresh-token',
    subject_token_type: TOKEN_TYPE_REFRESH,
    scope: SCOPE,
    resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}`,
    ...overrides,
  }).toString();
}

function event(extraHeaders: Record<string, string[]>, body = formBody()): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/oauth2/token',
    multiValueHeaders: { 'content-type': ['application/x-www-form-urlencoded'], ...extraHeaders },
    body,
    isBase64Encoded: false,
    multiValueQueryStringParameters: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
  } as unknown as APIGatewayProxyEvent;
}

function headers(result: APIGatewayProxyResult): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.multiValueHeaders ?? {})) {
    flat[k.toLowerCase()] = (v as Array<string | number | boolean>).join(', ');
  }
  return flat;
}

beforeEach(() => {
  cognitoMock.reset();
  dynamoMock.reset();
  dynamoMock.on(Query).resolves({ Items: [{ PK: SCOPE_PARTITION_KEY, SK: SCOPE }] });
  cognitoMock.on(GetTokens).resolves({ AuthenticationResult: { AccessToken: ACCESS, ExpiresIn: 300 } });
});

describe('a listed Origin reads every answer the function makes', () => {
  it('200, browser Content-Type with ;charset=UTF-8', async () => {
    const result = await handler(
      event({ 'content-type': ['application/x-www-form-urlencoded;charset=UTF-8'], 'Origin': [LISTED] }),
    );
    expect(result.statusCode).toBe(200);
    const h = headers(result);
    expect(h['access-control-allow-origin']).toBe(LISTED);
    expect(h.vary).toBe('Origin');
    expect(h['cache-control']).toBe('no-store');
    expect(h['access-control-allow-credentials']).toBeUndefined();
  });

  it('OAuth error (unsupported_grant_type), tenant host under the pattern', async () => {
    const result = await handler(event({ origin: [TENANT_HOST] }, formBody({ grant_type: 'password' })));
    expect(result.statusCode).toBe(400);
    expect(headers(result)['access-control-allow-origin']).toBe(TENANT_HOST);
    expect(headers(result).vary).toBe('Origin');
  });

  it('server_error (Cognito returned an un-narrowed token)', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: fakeJwt({ token_use: 'access', tenants: [TENANT_A], scope: SCOPE }), ExpiresIn: 300 },
    });
    const result = await handler(event({ origin: [LISTED] }));
    expect(result.statusCode).toBe(500);
    expect(headers(result)['access-control-allow-origin']).toBe(LISTED);
    expect(headers(result).vary).toBe('Origin');
  });

  it('framework error (unsupported media type)', async () => {
    const result = await handler(event({ 'content-type': ['application/json'], 'origin': [LISTED] }));
    expect(result.statusCode).toBe(415);
    expect(headers(result)['access-control-allow-origin']).toBe(LISTED);
    expect(headers(result).vary).toBe('Origin');
  });
});

describe('an unlisted, missing or repeated Origin still gets the exchange, without the header', () => {
  it.each([
    ['unlisted', { origin: ['https://evil.example.com'] }],
    ['two labels under the pattern', { origin: ['https://a.b.tenants.example.com'] }],
    ['null', { origin: ['null'] }],
    ['missing', {}],
    ['repeated', { origin: [LISTED, 'https://evil.example.com'] }],
  ])('%s', async (_label, extra) => {
    const result = await handler(event(extra as Record<string, string[]>));
    expect(result.statusCode).toBe(200);
    const h = headers(result);
    expect(h['access-control-allow-origin']).toBeUndefined();
    expect(h.vary).toBe('Origin');
  });
});
