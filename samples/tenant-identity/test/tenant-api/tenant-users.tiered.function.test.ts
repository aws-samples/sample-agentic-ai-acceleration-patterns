// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';

/**
 * The tenant-users handler's cold-start wiring in a `tiered` deployment
 * (ADR-0027 with ADR-0026): the stack sets both the shared pool and the
 * tenant-scoped role. The service resolves each request's provisioner from
 * the tenant row's topology, and the function picks the credentials by it:
 * a premium (pool-per-tenant) tenant runs on credentials assumed for that
 * tenant (the IAM wall), a standard (shared-pool) tenant on the function's
 * own client (the code-only wall, T-18). STS is never called for a standard
 * tenant.
 */

process.env.AWS_REGION = 'eu-central-1';
process.env.TOPOLOGY = 'tiered';
process.env.TABLE_NAME = 'registry-table';
process.env.USER_POOL_ID = 'eu-central-1_shared';
process.env.APP_CLIENT_ID = 'shared-client';
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

// One createProvisioners call per credential set: the function's own at cold
// start, then one per premium tenant. The dispatcher it returns tags each
// provisioner with the set it came from and the topology asked for.
const built: { deployment: string; deps: any }[] = [];
jest.mock('../../src/topology', () => ({
  // The real predicate: which topology runs on tenant-scoped credentials.
  usesTenantScopedCredentials: jest.requireActual('../../src/topology').usesTenantScopedCredentials,
  createProvisioners: (deployment: string, deps: unknown) => {
    const set = built.push({ deployment, deps }) - 1;
    return (topology: string) => ({ set, topology });
  },
}));

// The row's topology comes from this table: the mocked service plays the
// registry read the real one does, then asks the factory as the real one does.
const topologyOf: Record<string, 'shared-pool' | 'pool-per-tenant'> = {};
let usedProvisioner: { set: number; topology: string } | undefined;
jest.mock('../../src/tenant-api/tenant-users', () => ({
  TenantUsersService: class {
    constructor(_registry: unknown, private readonly provisionerFor: (t: string, topology: string) => unknown) {}
    async ListTenantUsers(_input: unknown, context: { tenantId: string }) {
      usedProvisioner = this.provisionerFor(context.tenantId, topologyOf[context.tenantId]) as typeof usedProvisioner;
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

const STANDARD = '01HZX9ABCDEFGHJKMNPQRSTVWX';
const PREMIUM = '01HZX9ABCDEFGHJKMNPQRSTVWY';
topologyOf[STANDARD] = 'shared-pool';
topologyOf[PREMIUM] = 'pool-per-tenant';

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

describe('tenant-users handler in a tiered deployment (ADR-0027, ADR-0026)', () => {
  it('builds every provisioner set for the tiered deployment, with the shared pool in its deps', () => {
    // Cold start built the function's own set already.
    expect(built).toHaveLength(1);
    expect(built[0].deployment).toBe('tiered');
    expect(built[0].deps.sharedPool).toEqual({ userPoolId: 'eu-central-1_shared', appClientId: 'shared-client' });
  });

  it('a standard tenant runs on the function\'s own client and never assumes the scoped role', async () => {
    await handler(proxyEvent(STANDARD));
    expect(usedProvisioner).toEqual({ set: 0, topology: 'shared-pool' });
    expect(built).toHaveLength(1);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('a premium tenant runs on credentials assumed for that tenant, reused across requests', async () => {
    await handler(proxyEvent(PREMIUM));
    const first = usedProvisioner;
    expect(first).toEqual({ set: 1, topology: 'pool-per-tenant' });
    expect(built[1].deployment).toBe('tiered');

    const creds = await built[1].deps.cognito.config.credentials();
    expect(creds.accessKeyId).toBe(`ASIA-${PREMIUM}`);
    const calls = sts.commandCalls(AssumeRoleCommand).map((c: any) => c.args[0].input);
    expect(calls).toHaveLength(1);
    expect(calls[0].Tags).toEqual([{ Key: 'TenantId', Value: PREMIUM }]);
    expect(calls[0].RoleArn).toBe(process.env.TENANT_SCOPED_ROLE_ARN);

    await handler(proxyEvent(PREMIUM));
    expect(usedProvisioner).toEqual(first); // the per-tenant set is memoised
    expect(built).toHaveLength(2);
  });

  it('a standard tenant after a premium one still takes the function\'s own set', async () => {
    await handler(proxyEvent(STANDARD));
    expect(usedProvisioner).toEqual({ set: 0, topology: 'shared-pool' });
    expect(built).toHaveLength(2);
  });
});
