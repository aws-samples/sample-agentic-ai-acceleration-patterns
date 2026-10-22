// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ENV } from '../../src/shared/constants';
import {
  ConflictError as DomainConflictError,
  NotFoundError,
  UnsupportedInTopologyError,
} from '../../src/shared/errors';
import type { TenantRecord } from '../../src/shared/registry';
import type { NewUserResult, Provisioner, UserView } from '../../src/topology/provisioner';

/**
 * Drives the real platform handler (routing + status codes + JSON bodies).
 * The topology module (`createProvisioner`) and the registry (DynamoDBRegistry)
 * are mocked so no AWS call is made; the Smithy handler, the mux, and the
 * service run for real. Proves 201/200/204/400/404/409 and that the handler
 * reads tenant identity from the path (spec §5.1, §5.3, ADR-0004).
 */

const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const FIXED_NOW = new Date('2026-10-21T11:00:00.000Z');

// --- Mocks installed before the handler module is imported -----------------

const store = new Map<string, TenantRecord>();
const provisionerMock: jest.Mocked<Provisioner> = {
  topology: 'shared-pool-multi-tenant',
  provisionTenant: jest.fn(),
  deprovisionTenant: jest.fn(),
  createUser: jest.fn(),
  assertMember: jest.fn(),
  getUser: jest.fn(),
  listUsers: jest.fn(),
  setAdmin: jest.fn(),
  deleteUser: jest.fn(),
  createMembership: jest.fn(),
  deleteMembership: jest.fn(),
  issueToken: jest.fn(),
  refreshToken: jest.fn(),
} as unknown as jest.Mocked<Provisioner>;

jest.mock('../../src/topology', () => ({
  createProvisioner: () => provisionerMock,
}));

jest.mock('../../src/shared/registry', () => {
  class FakeDynamoDBRegistry {
    async get(tenantId: string): Promise<TenantRecord | undefined> {
      return store.get(tenantId);
    }
    async list(): Promise<{ items: TenantRecord[]; nextToken?: string }> {
      return { items: [...store.values()] };
    }
    async create(record: TenantRecord): Promise<void> {
      store.set(record.tenantId, record);
    }
    async activate(
      tenantId: string,
      provisioned: { userPoolId?: string; appClientId?: string; issuer?: string; groupName?: string },
    ): Promise<TenantRecord> {
      // ADR-0021: flip PROVISIONING -> ACTIVE, writing only the DEFINED provisioned
      // fields (mirrors DynamoDBRegistry.activate).
      const existing = store.get(tenantId);
      if (existing === undefined || existing.status !== 'PROVISIONING') {
        throw new DomainConflictError(`Tenant ${tenantId} is not PROVISIONING`);
      }
      const defined = Object.fromEntries(Object.entries(provisioned).filter(([, v]) => v !== undefined));
      const updated: TenantRecord = { ...existing, ...defined, status: 'ACTIVE' };
      store.set(tenantId, updated);
      return updated;
    }
    async markDeleting(tenantId: string): Promise<TenantRecord> {
      const existing = store.get(tenantId);
      if (existing === undefined) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }
      const updated: TenantRecord = { ...existing, status: 'DELETING' };
      store.set(tenantId, updated);
      return updated;
    }
    async delete(tenantId: string): Promise<void> {
      store.delete(tenantId);
    }
    async batchGet(): Promise<TenantRecord[]> {
      return [];
    }
    async getByUserPoolId(): Promise<TenantRecord | undefined> {
      return undefined;
    }
  }
  return { DynamoDBRegistry: FakeDynamoDBRegistry };
});

process.env[ENV.topology] = 'shared-pool-multi-tenant';
process.env[ENV.tableName] = 'TestTable';
process.env[ENV.poolIndexName] = 'byUserPoolId';
process.env.AWS_REGION = 'eu-central-1';

// Import after the mocks and env are set so cold-start wiring uses them.
// eslint-disable-next-line import/order
import { handler } from '../../src/platform/platform.function';

function activeTenant(): TenantRecord {
  return {
    tenantId: TENANT_A,
    name: 'Acme',
    status: 'ACTIVE',
    topology: 'shared-pool-multi-tenant',
    groupName: `t-${TENANT_A}`,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
  };
}

function userView(username = 'u1', admin = false): UserView {
  return { username, email: `${username}@example.com`, admin, status: 'CONFIRMED', createdAt: FIXED_NOW };
}

/** Builds a payload-v1 API Gateway proxy event the handler converts. */
function event(
  method: string,
  path: string,
  body?: unknown,
  pathParameters: Record<string, string> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    resource: path,
    pathParameters,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      identity: { userArn: 'arn:aws:iam::123456789012:role/Vendor' },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  store.clear();
});

describe('platform.function handler (spec §5.1 routing and status codes)', () => {
  it('CreateTenant -> 201 with tenant and admin (ADR-0004)', async () => {
    provisionerMock.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
    const newUser: NewUserResult = { user: userView('admin', true), temporaryPassword: 'Temp#1234' };
    provisionerMock.createUser.mockResolvedValue(newUser);

    const res = await handler(event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'admin@example.com' }));

    expect(res.statusCode).toBe(201);
    const parsed = JSON.parse(res.body);
    expect(parsed.tenant.status).toBe('ACTIVE');
    expect(parsed.admin.user.admin).toBe(true);
    expect(parsed.admin.temporaryPassword).toBe('Temp#1234');
  });

  it('GetTenant -> 200 with the tenant body', async () => {
    store.set(TENANT_A, activeTenant());
    const res = await handler(event('GET', `/platform/tenants/${TENANT_A}`, undefined, { tenantId: TENANT_A }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tenant.tenantId).toBe(TENANT_A);
  });

  it('GetTenant unknown -> 404 ResourceNotFoundError', async () => {
    const res = await handler(event('GET', `/platform/tenants/${TENANT_A}`, undefined, { tenantId: TENANT_A }));
    expect(res.statusCode).toBe(404);
  });

  it('DeleteTenant -> 204 (no body) and removes the tenant', async () => {
    store.set(TENANT_A, activeTenant());
    provisionerMock.deprovisionTenant.mockResolvedValue(undefined);
    const res = await handler(event('DELETE', `/platform/tenants/${TENANT_A}`, undefined, { tenantId: TENANT_A }));
    expect(res.statusCode).toBe(204);
    expect(store.has(TENANT_A)).toBe(false);
  });

  it('CreateMembership in an unsupported topology -> 400 ValidationError (P-4)', async () => {
    store.set(TENANT_A, activeTenant());
    provisionerMock.createMembership.mockRejectedValue(
      new UnsupportedInTopologyError('CreateMembership', 'shared-pool'),
    );
    const res = await handler(
      event('PUT', `/platform/tenants/${TENANT_A}/users/u1/membership`, undefined, {
        tenantId: TENANT_A,
        username: 'u1',
      }),
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.reason).toBe('UnsupportedInTopology');
  });

  it('CreateUser on a DELETING tenant -> 409 ConflictError', async () => {
    store.set(TENANT_A, { ...activeTenant(), status: 'DELETING' });
    const res = await handler(
      event('POST', `/platform/tenants/${TENANT_A}/users`, { email: 'u1@example.com' }, { tenantId: TENANT_A }),
    );
    expect(res.statusCode).toBe(409);
  });

  it('bad tenantId pattern -> 400 ValidationException (framework validation)', async () => {
    const res = await handler(
      event('GET', '/platform/tenants/not-a-ulid', undefined, { tenantId: 'not-a-ulid' }),
    );
    expect(res.statusCode).toBe(400);
    // restJson1 carries the error type in the x-amzn-errortype header; the
    // body holds the modeled ValidationException fields (fieldList + message).
    const parsed = JSON.parse(res.body);
    expect(parsed.fieldList?.[0]?.path).toBe('/tenantId');
    expect(parsed.message).toContain('tenantId');
  });

  it('unknown provisioner failure -> 500 without leaking the message (N-6)', async () => {
    store.set(TENANT_A, activeTenant());
    provisionerMock.getUser.mockRejectedValue(new Error('secret cognito detail'));
    const res = await handler(
      event('GET', `/platform/tenants/${TENANT_A}/users/u1`, undefined, { tenantId: TENANT_A, username: 'u1' }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret cognito detail');
  });

  it('DeleteMembership last-tenant conflict -> 409', async () => {
    store.set(TENANT_A, activeTenant());
    provisionerMock.deleteMembership.mockRejectedValue(new DomainConflictError('last tenant'));
    const res = await handler(
      event('DELETE', `/platform/tenants/${TENANT_A}/users/u1/membership`, undefined, {
        tenantId: TENANT_A,
        username: 'u1',
      }),
    );
    expect(res.statusCode).toBe(409);
  });
});
