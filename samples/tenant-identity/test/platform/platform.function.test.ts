// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ENV } from '../../src/shared/constants';
import {
  ConflictError as DomainConflictError,
  NotFoundError,
  UnsupportedInTopologyError,
} from '../../src/shared/errors';
import type { ActivatedFields, TenantRecord } from '../../src/shared/registry';
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
const scopeStore = new Map<string, { name: string; owner: string; description?: string; createdAt: string }>();
const provisionerMock: jest.Mocked<Provisioner> = {
  topology: 'shared-pool-multi-tenant',
  provisionTenant: jest.fn(),
  deprovisionTenant: jest.fn(),
  assertEmailAvailable: jest.fn(),
  createUser: jest.fn(),
  assertMember: jest.fn(),
  getUser: jest.fn(),
  listUsers: jest.fn(),
  setAdmin: jest.fn(),
  setScopes: jest.fn(),
  deleteUser: jest.fn(),
  createMembership: jest.fn(),
  deleteMembership: jest.fn(),
  issueToken: jest.fn(),
  refreshToken: jest.fn(),
} as unknown as jest.Mocked<Provisioner>;

// ADR-0027: the handler now asks the dispatcher for a strategy per row; one
// mock answers for every topology here (a single-topology stack).
jest.mock('../../src/topology', () => ({
  createProvisioners: () => () => provisionerMock,
}));

// ADR-0025: no API Gateway call leaves the test; CreateTenant gets a key.
const apiKeysMock = {
  create: jest.fn(async (tenantId: string) => ({ apiKeyId: `key-${tenantId}`, apiKeyValue: `value-${tenantId}` })),
  delete: jest.fn(async () => undefined),
};
/** The constructor arguments the handler wires at cold start (ADR-0025, ADR-0027). */
const apiKeysCtorArgs: unknown[][] = [];
jest.mock('../../src/shared/tenant-api-keys', () => ({
  ApiGatewayTenantApiKeys: class {
    create = apiKeysMock.create;
    delete = apiKeysMock.delete;
    constructor(...args: unknown[]) {
      apiKeysCtorArgs.push(args);
    }
  },
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
      // Mirrors DynamoDBRegistry.create's attribute_not_exists(PK) condition.
      if (store.has(record.tenantId)) {
        throw new DomainConflictError(`Tenant ${record.tenantId} already exists`);
      }
      store.set(record.tenantId, record);
    }
    async activate(tenantId: string, provisioned: ActivatedFields): Promise<TenantRecord> {
      // ADR-0021: flip PROVISIONING -> ACTIVE, writing only the DEFINED provisioned
      // fields (mirrors DynamoDBRegistry.activate), the first-admin slot included.
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
    async claimFirstAdmin(tenantId: string, email: string): Promise<void> {
      // ADR-0032: mirrors DynamoDBRegistry.claimFirstAdmin (one conditional write).
      const existing = store.get(tenantId);
      if (existing === undefined) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }
      if (existing.firstAdminEmail !== undefined) {
        throw new DomainConflictError(`Tenant ${tenantId} already has a first admin`);
      }
      store.set(tenantId, { ...existing, firstAdminEmail: email });
    }
    async confirmFirstAdmin(tenantId: string, email: string): Promise<void> {
      // ADR-0032: mirrors DynamoDBRegistry.confirmFirstAdmin (empty or ours -> written).
      const existing = store.get(tenantId);
      if (existing === undefined) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }
      if (existing.firstAdminEmail !== undefined && existing.firstAdminEmail !== email) {
        throw new DomainConflictError(`Tenant ${tenantId} already has a first admin`);
      }
      store.set(tenantId, { ...existing, firstAdminEmail: email });
    }
    async releaseFirstAdmin(tenantId: string, email: string): Promise<void> {
      const existing = store.get(tenantId);
      if (existing === undefined || existing.firstAdminEmail !== email) {
        return;
      }
      const { firstAdminEmail: _released, ...rest } = existing;
      store.set(tenantId, rest);
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
    // ADR-0034 / ADR-0035: the catalogue and the entitlement, in memory.
    async listScopeNames(): Promise<string[]> {
      return [...scopeStore.keys()];
    }
    async putScope(scope: { name: string; owner: string; description?: string }) {
      const written = { ...scope, createdAt: scopeStore.get(scope.name)?.createdAt ?? '2026-10-29T00:00:00.000Z' };
      scopeStore.set(scope.name, written);
      return written;
    }
    async getScope(name: string) {
      return scopeStore.get(name);
    }
    async listScopes() {
      return { items: [...scopeStore.values()] };
    }
    async deleteScope(name: string): Promise<void> {
      scopeStore.delete(name);
    }
    async updateTenantScopes(tenantId: string, scopes: readonly string[]): Promise<TenantRecord> {
      const existing = store.get(tenantId);
      if (existing === undefined) {
        throw new NotFoundError(`Tenant ${tenantId} not found`);
      }
      const updated: TenantRecord = { ...existing, scopes: [...scopes] };
      store.set(tenantId, updated);
      return updated;
    }
  }
  // The module also exports the pure helper the service reads rows with.
  const tenantScopes = (record: { scopes?: readonly string[] }) => record.scopes ?? [];
  return { DynamoDBRegistry: FakeDynamoDBRegistry, tenantScopes };
});

process.env[ENV.topology] = 'shared-pool-multi-tenant';
process.env[ENV.tableName] = 'TestTable';
process.env[ENV.poolIndexName] = 'byUserPoolId';
process.env[ENV.tenantUsagePlanName] = 'TenantIdentity-test-tenant';
process.env[ENV.stackName] = 'TenantIdentity-test';
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
  scopeStore.clear();
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

  describe('caller-supplied tenantId on CreateTenant (ADR-0029)', () => {
    const SUPPLIED = '01HZXK5V3P9Q7R2T4W6Y8A0BCD';

    beforeEach(() => {
      provisionerMock.provisionTenant.mockResolvedValue({ groupName: `t-${SUPPLIED}` });
      provisionerMock.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'Temp#1234' });
      provisionerMock.provisionTenant.mockClear();
      provisionerMock.createUser.mockClear();
    });

    it('a valid ULID is used as the tenant id -> 201', async () => {
      const res = await handler(
        event('POST', '/platform/tenants', { tenantId: SUPPLIED, name: 'Acme', adminEmail: 'admin@example.com' }),
      );
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).tenant.tenantId).toBe(SUPPLIED);
      expect(store.has(SUPPLIED)).toBe(true);
    });

    it('a bad pattern -> 400 from the generated validator, before any write (M-R-3)', async () => {
      const res = await handler(
        event('POST', '/platform/tenants', { tenantId: 'not-a-ulid', name: 'Acme', adminEmail: 'admin@example.com' }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).fieldList?.[0]?.path).toBe('/tenantId');
      expect(store.size).toBe(0);
      expect(provisionerMock.provisionTenant).not.toHaveBeenCalled();
    });

    it('an existing id -> 409 ConflictError, nothing changed (M-R-2)', async () => {
      const before = { ...activeTenant(), tenantId: SUPPLIED };
      store.set(SUPPLIED, before);
      const res = await handler(
        event('POST', '/platform/tenants', { tenantId: SUPPLIED, name: 'Replay', adminEmail: 'other@example.com' }),
      );
      expect(res.statusCode).toBe(409);
      expect(store.get(SUPPLIED)).toEqual(before);
      expect(provisionerMock.provisionTenant).not.toHaveBeenCalled();
      expect(provisionerMock.createUser).not.toHaveBeenCalled();
    });
  });

  describe('firstAdmin on CreateUser (ADR-0032)', () => {
    const FIRST = 'success+admin@simulator.amazonses.com';

    beforeEach(() => {
      provisionerMock.createUser.mockReset();
    });

    it('claims the slot and creates the admin -> 201; a second firstAdmin -> 409 with no Cognito call', async () => {
      store.set(TENANT_A, activeTenant());
      provisionerMock.createUser.mockResolvedValue({ user: { ...userView('sub-1', true), email: FIRST }, temporaryPassword: 'Temp#1234' });

      const first = await handler(
        event('POST', `/platform/tenants/${TENANT_A}/users`, { email: FIRST, firstAdmin: true }, { tenantId: TENANT_A }),
      );
      expect(first.statusCode).toBe(201);
      expect(JSON.parse(first.body).user.admin).toBe(true);
      expect(store.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);

      const second = await handler(
        event('POST', `/platform/tenants/${TENANT_A}/users`, { email: 'other@example.com', firstAdmin: true }, { tenantId: TENANT_A }),
      );
      expect(second.statusCode).toBe(409);
      expect(provisionerMock.createUser).toHaveBeenCalledTimes(1);

      // A plain admin is still allowed.
      const plain = await handler(
        event('POST', `/platform/tenants/${TENANT_A}/users`, { email: 'other@example.com', admin: true }, { tenantId: TENANT_A }),
      );
      expect(plain.statusCode).toBe(201);
    });

    it('a Cognito refusal after the claim releases the slot and returns that error (409 here)', async () => {
      store.set(TENANT_A, activeTenant());
      provisionerMock.createUser.mockRejectedValue(new DomainConflictError('E-mail already exists'));
      const res = await handler(
        event('POST', `/platform/tenants/${TENANT_A}/users`, { email: FIRST, firstAdmin: true }, { tenantId: TENANT_A }),
      );
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe('E-mail already exists');
      expect(store.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
    });

    it('GetTenant never carries firstAdminEmail (mounting spec §10 step 4)', async () => {
      store.set(TENANT_A, { ...activeTenant(), firstAdminEmail: FIRST });
      const res = await handler(event('GET', `/platform/tenants/${TENANT_A}`, undefined, { tenantId: TENANT_A }));
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('firstAdminEmail');
      expect(res.body).not.toContain(FIRST);
    });

    it('DeleteUser of the holder -> 204 and the slot is released', async () => {
      store.set(TENANT_A, { ...activeTenant(), firstAdminEmail: FIRST });
      provisionerMock.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
      provisionerMock.deleteUser.mockResolvedValue(undefined);
      const res = await handler(
        event('DELETE', `/platform/tenants/${TENANT_A}/users/sub-1`, undefined, { tenantId: TENANT_A, username: 'sub-1' }),
      );
      expect(res.statusCode).toBe(204);
      expect(store.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
    });
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

  describe('tier (ADR-0027)', () => {
    it('CreateTenant with a tier on a single-topology stack -> 400 UnsupportedInTopology', async () => {
      const res = await handler(
        event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'admin@example.com', tier: 'premium' }),
      );
      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.reason).toBe('UnsupportedInTopology');
      expect(parsed.message).toBe('tier is only accepted in a tiered deployment');
      expect(store.size).toBe(0);
    });

    it('CreateTenant with an unknown tier -> 400 from the generated enum validator', async () => {
      const res = await handler(
        event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'admin@example.com', tier: 'gold' }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).fieldList?.[0]?.path).toBe('/tier');
    });

    it('GetTenant carries no tier on a single-topology stack', async () => {
      store.set(TENANT_A, activeTenant());
      const res = await handler(event('GET', `/platform/tenants/${TENANT_A}`, undefined, { tenantId: TENANT_A }));
      expect(JSON.parse(res.body).tenant).not.toHaveProperty('tier');
    });

    it('cold start passes the premium plan name through as the fourth key-module argument (unset here)', () => {
      // Read unconditionally (P-1); only a `tiered` stack sets it.
      expect(apiKeysCtorArgs[0]).toEqual([
        expect.anything(),
        'TenantIdentity-test-tenant',
        'TenantIdentity-test',
        undefined,
      ]);
    });

    it('a tiered stack: CreateTenant without a tier -> 400 InvalidInput, with one it provisions and returns the tier', async () => {
      // A second cold start with TOPOLOGY=tiered and the premium plan set.
      // Everything else (mocks, store) is shared with the main handler.
      process.env[ENV.topology] = 'tiered';
      process.env[ENV.premiumUsagePlanName] = 'TenantIdentity-test-tenant-premium';
      let tiered: typeof handler;
      jest.isolateModules(() => {
        // A fresh module registry so the cold-start wiring re-runs with the
        // tiered env; the jest.mock factories above still apply to it.
        tiered = (jest.requireActual('../../src/platform/platform.function') as { handler: typeof handler }).handler;
      });
      process.env[ENV.topology] = 'shared-pool-multi-tenant';
      delete process.env[ENV.premiumUsagePlanName];

      expect(apiKeysCtorArgs[apiKeysCtorArgs.length - 1][3]).toBe('TenantIdentity-test-tenant-premium');

      const missing = await tiered!(event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'a@example.com' }));
      expect(missing.statusCode).toBe(400);
      expect(JSON.parse(missing.body)).toMatchObject({
        reason: 'InvalidInput',
        message: 'tier is required in a tiered deployment',
      });
      expect(store.size).toBe(0);

      provisionerMock.provisionTenant.mockResolvedValue({ userPoolId: 'eu-central-1_P', appClientId: 'c', issuer: 'i' });
      provisionerMock.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });
      const created = await tiered!(
        event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'a@example.com', tier: 'premium' }),
      );
      expect(created.statusCode).toBe(201);
      const parsed = JSON.parse(created.body);
      expect(parsed.tenant.topology).toBe('pool-per-tenant');
      expect(parsed.tenant.tier).toBe('premium');
      // The key went to the premium tier's plan.
      expect(apiKeysMock.create).toHaveBeenLastCalledWith(parsed.tenant.tenantId, 'premium');
    });
  });

  describe('scope catalogue and entitlement routes (ADR-0034, ADR-0035, ADR-0036)', () => {
    const encoded = encodeURIComponent('billing/read');

    it('PUT/GET/DELETE /platform/scopes/{scope} and GET /platform/scopes route to the catalogue', async () => {
      const put = await handler(event('PUT', `/platform/scopes/${encoded}`, { description: 'Read invoices' }, { scope: 'billing/read' }));
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body).scope).toMatchObject({ name: 'billing/read', owner: 'billing', description: 'Read invoices' });
      const get = await handler(event('GET', `/platform/scopes/${encoded}`, undefined, { scope: 'billing/read' }));
      expect(get.statusCode).toBe(200);
      const list = await handler(event('GET', '/platform/scopes'));
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).scopes.map((s: { name: string }) => s.name)).toEqual(['billing/read']);
      const del = await handler(event('DELETE', `/platform/scopes/${encoded}`, undefined, { scope: 'billing/read' }));
      expect(del.statusCode).toBe(204);
      const gone = await handler(event('GET', `/platform/scopes/${encoded}`, undefined, { scope: 'billing/read' }));
      expect(gone.statusCode).toBe(404);
    });

    it('a reserved or malformed scope label is a 400 before the service runs', async () => {
      const reserved = await handler(event('PUT', '/platform/scopes/tenant-admin%2Fx', undefined, { scope: 'tenant-admin/x' }));
      expect(reserved.statusCode).toBe(400);
      expect(JSON.parse(reserved.body).message).toMatch(/^invalid_scope/);
      const malformed = await handler(event('PUT', '/platform/scopes/Bad%2FName', undefined, { scope: 'Bad/Name' }));
      expect(malformed.statusCode).toBe(400);
      expect(scopeStore.size).toBe(0);
    });

    it('PATCH /platform/tenants/{tenantId} replaces the entitlement; CreateTenant.scopes is validated', async () => {
      scopeStore.set('billing/read', { name: 'billing/read', owner: 'billing', createdAt: '2026-10-29T00:00:00.000Z' });
      store.set(TENANT_A, activeTenant());
      const patch = await handler(event('PATCH', `/platform/tenants/${TENANT_A}`, { scopes: ['billing/read'] }, { tenantId: TENANT_A }));
      expect(patch.statusCode).toBe(200);
      expect(JSON.parse(patch.body).tenant.scopes).toEqual(['billing/read']);
      const refused = await handler(event('PATCH', `/platform/tenants/${TENANT_A}`, { scopes: ['nosuch/scope'] }, { tenantId: TENANT_A }));
      expect(refused.statusCode).toBe(400);
      expect(JSON.parse(refused.body).message).toMatch(/^invalid_scope/);
      const created = await handler(event('POST', '/platform/tenants', { name: 'Acme', adminEmail: 'a@example.com', scopes: ['nosuch/scope'] }));
      expect(created.statusCode).toBe(400);
      expect(provisionerMock.provisionTenant).not.toHaveBeenCalled();
    });

    it('PATCH .../users/{username} with scopes only (no admin) is accepted', async () => {
      store.set(TENANT_A, { ...activeTenant(), scopes: ['billing/read'] });
      scopeStore.set('billing/read', { name: 'billing/read', owner: 'billing', createdAt: '2026-10-29T00:00:00.000Z' });
      provisionerMock.setScopes.mockResolvedValue({ ...userView('u1'), grantedScopes: ['billing/read'] });
      const res = await handler(event('PATCH', `/platform/tenants/${TENANT_A}/users/u1`, { scopes: ['billing/read'] }, { tenantId: TENANT_A, username: 'u1' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).user.scopes).toEqual(['billing/read']);
      expect(provisionerMock.setAdmin).not.toHaveBeenCalled();
    });
  });
});
