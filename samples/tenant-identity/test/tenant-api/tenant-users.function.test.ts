// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Unit tests for the tenant-users handler (P-11, spec §10 "reads the tenant
 * only from the authoriser context"). A missing authoriser context is an
 * ingress wiring bug → 500. The topology module and registry are mocked so
 * the cold-start wiring loads without the sibling workers' files, and so the
 * test proves the handler takes the tenant from the context, never the event.
 */

// Cold start reads these at module load, before any test runs.
process.env.AWS_REGION = 'eu-central-1';
process.env.TOPOLOGY = 'shared-pool';
process.env.TABLE_NAME = 'registry-table';
process.env.USER_POOL_ID = 'eu-central-1_pool';
process.env.APP_CLIENT_ID = 'client';

// Mock the topology barrel: createProvisioner must not build real Cognito
// strategies (and its sibling files may not exist yet in a parallel build).
const provisionerCalls: unknown[] = [];
jest.mock('../../src/topology', () => ({
  createProvisioner: (topology: string, deps: unknown) => {
    provisionerCalls.push({ topology, deps });
    return { topology };
  },
}));

// Capture the context the service handler is dispatched with.
const handleMock = jest.fn().mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' });
let capturedContext: unknown;
jest.mock('../../src/smithy/tenant/typescript-ssdk-codegen/src', () => ({
  getTenantServiceServiceHandler: () => ({
    handle: (_req: unknown, context: unknown) => {
      capturedContext = context;
      return handleMock(_req, context);
    },
  }),
}));

// Avoid constructing a real DynamoDB registry at cold start.
jest.mock('../../src/shared/registry', () => ({
  DynamoDBRegistry: class {},
}));

const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';

function proxyEvent(authorizer: Record<string, unknown> | null): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/tenant/users',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    resource: '/tenant/users',
    requestContext: { authorizer } as unknown as APIGatewayProxyEvent['requestContext'],
  } as APIGatewayProxyEvent;
}

// Required after the mocks and env are in place. `require` (not a static or
// dynamic import) keeps the module load after the module-scope env
// assignments above, so the handler's cold-start `requireEnv` reads them; a
// hoisted static import would run before them, and a dynamic `import()`
// expression trips the nodenext resolver. The typeof cast keeps it typed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../src/tenant-api/tenant-users.function') as typeof import('../../src/tenant-api/tenant-users.function');

describe('tenant-users handler (P-11)', () => {
  afterEach(() => {
    capturedContext = undefined;
    handleMock.mockClear();
  });

  it('dispatches with the authoriser context {tenantId, sub}, not the event', async () => {
    await handler(proxyEvent({ tenantId: TENANT_A, sub: 'admin-1' }));
    expect(capturedContext).toEqual({ tenantId: TENANT_A, sub: 'admin-1' });
  });

  it('returns 500 when the authoriser context is missing (ingress wiring bug)', async () => {
    const result = await handler(proxyEvent(null));
    expect(result.statusCode).toBe(500);
    expect(handleMock).not.toHaveBeenCalled();
  });

  it('returns 500 when sub is present but tenantId is missing', async () => {
    const result = await handler(proxyEvent({ sub: 'admin-1' }));
    expect(result.statusCode).toBe(500);
    expect(handleMock).not.toHaveBeenCalled();
  });
});
