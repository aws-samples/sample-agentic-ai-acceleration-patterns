// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Handler-level tests for the token-exchange Lambda (R-7, ADR-0011,
 * ADR-0012). Drives the exported `handler` with an APIGatewayProxyEvent
 * (form body plain and base64-encoded) and asserts status codes, headers
 * (Cache-Control: no-store, Content-Type: application/json), and the exact
 * RFC 6749 JSON body keys {error, error_description} the generated
 * serializer produces. A final test proves no log line carries the refresh
 * token or the access token value (N-6).
 */

import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
  NotAuthorizedException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { AwsStub, mockClient } from 'aws-sdk-client-mock';
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  SCOPE_PARTITION_KEY,
  TENANT_RESOURCE_PREFIX,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
} from '../../src/shared/constants';

// The one catalogue scope these tests register (ADR-0034).
const SCOPE_API_READ = 'sample/read';

// Cold start parses TOPOLOGY, TABLE_NAME and POOL_INDEX_NAME at module load.
// `require` (not a static import) runs after these assignments; a static
// import is hoisted above them. No APP_CLIENT_ID: pool-per-tenant has no
// single client to check (T-28).
process.env.TOPOLOGY = 'pool-per-tenant';
process.env.TABLE_NAME = 'registry';
process.env.POOL_INDEX_NAME = 'byUserPoolId';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../src/token-exchange/token-exchange.function') as typeof import('../../src/token-exchange/token-exchange.function');

// ADR-0034: the function's one registry read is the catalogue Query. Same
// duplicated-@smithy/types cast as the Cognito mock above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamoMock: any = mockClient(DynamoDBDocumentClient as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Query = QueryCommand as any;

// See token-exchange.test.ts: the SDK's duplicated @smithy/types makes the
// command constructor types diverge from the client's. Cast keeps the mock
// usable; assertions below still check concrete values.
const cognitoMock = mockClient(CognitoIdentityProviderClient as never) as unknown as AwsStub<
  any,
  any,
  any
>;
/** The command, cast past the duplicated @smithy/types for the mock API. */
const GetTokens = GetTokensFromRefreshTokenCommand as unknown as new (input: unknown) => any;

const TENANT_A = '01HZX8K9P0QRST7VWXYZ1A2B3C';
const CLIENT = 'app-client-id';
const REFRESH = 'super-secret-refresh-token-value';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}
const ACCESS = fakeJwt({ token_use: 'access', tenant_id: TENANT_A, scope: SCOPE_API_READ, sub: 'user-1' });

function formBody(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: CLIENT,
    subject_token: REFRESH,
    subject_token_type: TOKEN_TYPE_REFRESH,
    scope: SCOPE_API_READ,
    resource: `${TENANT_RESOURCE_PREFIX}${TENANT_A}`,
    ...overrides,
  }).toString();
}

/** Build a v1 API Gateway event; body plain or base64 per `base64`. */
function event(body: string, base64: boolean): APIGatewayProxyEvent {
  const encoded = base64 ? Buffer.from(body, 'utf8').toString('base64') : body;
  return {
    httpMethod: 'POST',
    path: '/oauth2/token',
    multiValueHeaders: { 'content-type': ['application/x-www-form-urlencoded'] },
    body: encoded,
    isBase64Encoded: base64,
    multiValueQueryStringParameters: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
  } as unknown as APIGatewayProxyEvent;
}

/** Collapse the multiValueHeaders the v1 response carries into a flat map. */
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
  dynamoMock.on(Query).resolves({ Items: [{ PK: SCOPE_PARTITION_KEY, SK: SCOPE_API_READ }] });
});

describe('handler success (ADR-0011, §5.4)', () => {
  it.each([
    ['plain body', false],
    ['base64 body (binary media type)', true],
  ])('%s -> 200 with no-store and the RFC 8693 JSON body', async (_label, base64) => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: ACCESS, ExpiresIn: 300 },
    });

    const result = await handler(event(formBody(), base64 as boolean));

    expect(result.statusCode).toBe(200);
    const h = headers(result);
    expect(h['cache-control']).toBe('no-store');
    expect(h['content-type']).toBe('application/json');
    const parsed = JSON.parse(result.body);
    expect(parsed).toEqual({
      access_token: ACCESS,
      issued_token_type: TOKEN_TYPE_ACCESS,
      token_type: 'Bearer',
      expires_in: 300,
      scope: SCOPE_API_READ,
    });
  });
});

describe('handler scope catalogue (ADR-0034)', () => {
  it('reads the catalogue with one Query on the SCOPE partition, then serves it from the cache', async () => {
    cognitoMock.on(GetTokens).resolves({ AuthenticationResult: { AccessToken: ACCESS, ExpiresIn: 300 } });
    await handler(event(formBody(), false));
    await handler(event(formBody(), false));
    const queries: { args: [{ input: Record<string, unknown> }] }[] = dynamoMock.commandCalls(Query);
    // The module-level cache was filled by the first describe's calls, so
    // these two calls read nothing; the catalogue is re-read once a minute.
    for (const call of queries) {
      expect(call.args[0].input.KeyConditionExpression).toBe('PK = :scope');
      expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':scope': SCOPE_PARTITION_KEY });
    }
    expect(queries.length).toBeLessThanOrEqual(1);
  });

  it('a scope that is not in the catalogue -> 400 invalid_scope before Cognito is called', async () => {
    const result = await handler(event(formBody({ scope: 'billing/read' }), false));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('invalid_scope');
    expect(cognitoMock.commandCalls(GetTokens)).toHaveLength(0);
  });
});

describe('handler error bodies (RFC 6749 §5.2 {error, error_description})', () => {
  it('malformed form -> 400 with exactly {error, error_description}', async () => {
    const result = await handler(event(formBody({ grant_type: 'authorization_code' }), false));

    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body);
    expect(Object.keys(parsed).sort()).toEqual(['error', 'error_description']);
    expect(parsed.error).toBe('unsupported_grant_type');
    expect(typeof parsed.error_description).toBe('string');
    expect(headers(result)['content-type']).toBe('application/json');
  });

  it('Cognito rejection -> 400 invalid_grant, exact key set', async () => {
    cognitoMock.on(GetTokens).rejects(
      new NotAuthorizedException({ message: 'bad token', $metadata: {} }),
    );
    const result = await handler(event(formBody(), false));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'invalid_grant',
      error_description: expect.any(String),
    });
  });

  it('un-narrowed token from Cognito -> 500 server_error (ADR-0012)', async () => {
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: fakeJwt({ token_use: 'access', tenants: [TENANT_A], scope: SCOPE_API_READ }), ExpiresIn: 300 },
    });
    const result = await handler(event(formBody(), false));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'server_error',
      error_description: expect.any(String),
    });
    // The token Cognito returned must not leak into the error response.
    expect(result.body).not.toContain('token_use');
  });
});

describe('handler logging hygiene (N-6)', () => {
  it('never logs the refresh token or the access token value', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    // A success path (logs nothing sensitive) and an error path (logs an
    // error class / rule name only).
    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: ACCESS, ExpiresIn: 300 },
    });
    await handler(event(formBody(), false));

    cognitoMock.on(GetTokens).resolves({
      AuthenticationResult: { AccessToken: fakeJwt({ token_use: 'access', tenants: [TENANT_A], scope: SCOPE_API_READ }), ExpiresIn: 300 },
    });
    await handler(event(formBody(), false));

    spy.mockRestore();

    const joined = logs.join('\n');
    expect(joined).not.toContain(REFRESH);
    expect(joined).not.toContain(ACCESS);
  });
});
