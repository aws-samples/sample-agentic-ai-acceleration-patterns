// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * The API handler end to end through the generated Smithy handler (spec
 * R-36, M26): the caller context it builds from the authorizer output, the
 * 500 on a missing or unknown grant, and the grant check's refusal
 * serialised as the modelled 403 `UnauthorizedError` with nothing run.
 */

process.env.TABLE_NAME = 'test-table';
process.env.FLEET_NAME = 'control-plane';
process.env.AWS_REGION = 'eu-central-1';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:eu-central-1:123456789012:stateMachine:test';

// No AWS call may run: a refused request must never reach the service.
const send = jest.fn(async () => {
  throw new Error('unexpected AWS call');
});
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send }) } };
});

import { handler } from '../../src/tenant/tenant.function';

function event(
  method: string,
  path: string,
  authorizer: Record<string, string> | undefined,
  body?: unknown,
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    resource: path,
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

beforeEach(() => send.mockClear());

test('a missing grant is an ingress fault: 500, nothing run', async () => {
  const result = await handler(event('GET', '/tenants', { operatorId: 'op-1', role: 'operator' }));
  expect(result.statusCode).toBe(500);
  expect(send).not.toHaveBeenCalled();
});

test('an unknown grant is an ingress fault: 500, nothing run', async () => {
  const result = await handler(event('GET', '/tenants', { operatorId: 'op-1', role: 'x', grant: 'admin' }));
  expect(result.statusCode).toBe(500);
  expect(send).not.toHaveBeenCalled();
});

test('a reader write is refused with the modelled 403 UnauthorizedError, nothing run', async () => {
  const result = await handler(
    event('POST', '/tenants', { operatorId: 'reader-1', role: 'control-plane:reader', grant: 'reader' }, { name: 'nope' }),
  );
  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body).message).toMatch(/reader grant does not include CreateTenant/);
  expect(send).not.toHaveBeenCalled();
});

test('a reader read reaches the service', async () => {
  send.mockResolvedValueOnce({ Items: [] } as never);
  const result = await handler(event('GET', '/tenants', { operatorId: 'reader-1', role: 'control-plane:reader', grant: 'reader' }));
  expect(send).toHaveBeenCalled();
  expect(result.statusCode).toBe(200);
});
