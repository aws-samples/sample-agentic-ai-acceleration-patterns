// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

/**
 * The tenant-users handler's cold-start wiring when the stack sets a
 * tenant-scoped role (ADR-0026, pool-per-tenant): each tenant gets its own
 * provisioner whose Cognito client signs with credentials assumed for that
 * tenant, tagged with the authoriser's tenant id.
 */

process.env.AWS_REGION = 'eu-central-1';
process.env.TOPOLOGY = 'pool-per-tenant';
process.env.TABLE_NAME = 'registry-table';
process.env.TENANT_SCOPED_ROLE_ARN = 'arn:aws:iam::123456789012:role/TenantScopedRole';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sts: any = mockClient(STSClient as any);
sts.on(AssumeRoleCommand).callsFake((input: { Tags: { Value: string }[] }) => ({
  Credentials: {
    AccessKeyId: `ASIA-${input.Tags[0].Value}`,
    SecretAccessKey: 'synthetic-secret',
    SessionToken: 'synthetic-session',
    Expiration: new Date(Date.now() + 900_000),
  },
}));

// Every createProvisioners call is one credential set: the function's own
// (built at cold start, never used here) and one per tenant on scoped
// credentials. The returned dispatcher hands back one object per set.
const built: { tenantDeps: any }[] = [];
jest.mock('../../src/topology', () => ({
  // The real predicate: which topology runs on tenant-scoped credentials.
  usesTenantScopedCredentials: jest.requireActual('../../src/topology').usesTenantScopedCredentials,
  createProvisioners: (_deployment: string, deps: unknown) => {
    built.push({ tenantDeps: deps });
    const provisioner = { built: built.length };
    return () => provisioner;
  },
}));

// Capture which provisioner the service would use for the request. Every
// tenant here is pool-per-tenant, as the deployment is.
let usedProvisioner: unknown;
jest.mock('../../src/tenant-api/tenant-users', () => ({
  TenantUsersService: class {
    constructor(_registry: unknown, private readonly provisionerFor: (t: string, topology: string) => unknown) {}
    async ListTenantUsers(_input: unknown, context: { tenantId: string }) {
      usedProvisioner = this.provisionerFor(context.tenantId, 'pool-per-tenant');
      return { users: [] };
    }
  },
}));
jest.mock('../../src/smithy/tenant/typescript-ssdk-codegen/src', () => ({
  getTenantServiceServiceHandler: (service: any) => ({
    handle: async (_req: unknown, context: unknown) => {
      await service.ListTenantUsers({}, context);
      return { statusCode: 200, headers: {}, body: '{}' };
    },
  }),
}));
jest.mock('../../src/shared/registry', () => ({ DynamoDBRegistry: class {} }));

const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';
const TENANT_B = '01HZX9ABCDEFGHJKMNPQRSTVWY';

function proxyEvent(tenantId: string): APIGatewayProxyEvent {
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
    requestContext: { authorizer: { tenantId, sub: 'admin-1' } } as unknown as APIGatewayProxyEvent['requestContext'],
  } as APIGatewayProxyEvent;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../../src/tenant-api/tenant-users.function') as typeof import('../../src/tenant-api/tenant-users.function');

describe('tenant-users handler with a tenant-scoped role (ADR-0026)', () => {
  it('builds one provisioner per tenant, each on credentials tagged with that tenant', async () => {
    await handler(proxyEvent(TENANT_A));
    const forA = usedProvisioner;
    await handler(proxyEvent(TENANT_A));
    expect(usedProvisioner).toBe(forA); // reused, not rebuilt
    await handler(proxyEvent(TENANT_B));
    expect(usedProvisioner).not.toBe(forA);
    // built[0] is the function's own set (cold start); then one per tenant.
    expect(built).toHaveLength(3);

    // Resolve each Cognito client's credentials: one AssumeRole per tenant,
    // with that tenant as the session tag.
    const credsA = await built[1].tenantDeps.cognito.config.credentials();
    const credsB = await built[2].tenantDeps.cognito.config.credentials();
    expect(credsA.accessKeyId).toBe(`ASIA-${TENANT_A}`);
    expect(credsB.accessKeyId).toBe(`ASIA-${TENANT_B}`);
    const calls = sts.commandCalls(AssumeRoleCommand).map((c: any) => c.args[0].input);
    expect(calls.map((i: any) => i.Tags)).toEqual([
      [{ Key: 'TenantId', Value: TENANT_A }],
      [{ Key: 'TenantId', Value: TENANT_B }],
    ]);
    expect(calls.every((i: any) => i.RoleArn === process.env.TENANT_SCOPED_ROLE_ARN && i.DurationSeconds === 900)).toBe(true);
  });
});
