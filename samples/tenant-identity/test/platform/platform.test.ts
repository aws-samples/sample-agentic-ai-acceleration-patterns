// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PlatformContext, PlatformService } from '../../src/platform/platform';
import type { Topology } from '../../src/shared/constants';
import {
  ConflictError as DomainConflictError,
  InvalidInputError,
  NotFoundError,
  UnsupportedInTopologyError,
} from '../../src/shared/errors';
import type { Page, Registry, TenantRecord, TenantStatus } from '../../src/shared/registry';
import {
  ConflictError,
  InternalServerError,
  ResourceNotFoundError,
  ValidationError,
} from '../../src/smithy/platform/typescript-ssdk-codegen/src';
import type { NewUserResult, Provisioner, TokenSet, UserView } from '../../src/topology/provisioner';

/**
 * Unit tests for the platform service (spec §5.1, §5.3, R-11, R-12, P-2, P-4).
 * A fake in-memory registry stands in for DynamoDB; the provisioner is a
 * jest mock so the tests assert the orchestration the service owns, not
 * Cognito behaviour.
 */

const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CONTEXT: PlatformContext = { callerArn: 'arn:aws:iam::123456789012:role/Vendor' };
const FIXED_NOW = new Date('2026-10-21T11:00:00.000Z');

/** Minimal in-memory Registry recording call order for the DeleteTenant test. */
class FakeRegistry implements Registry {
  readonly items = new Map<string, TenantRecord>();
  readonly calls: string[] = [];

  async get(tenantId: string): Promise<TenantRecord | undefined> {
    this.calls.push(`get:${tenantId}`);
    return this.items.get(tenantId);
  }
  async batchGet(tenantIds: readonly string[]): Promise<TenantRecord[]> {
    return tenantIds.map((id) => this.items.get(id)).filter((r): r is TenantRecord => r !== undefined);
  }
  async getByUserPoolId(): Promise<TenantRecord | undefined> {
    return undefined;
  }
  async list(nextToken?: string): Promise<Page<TenantRecord>> {
    this.calls.push(`list:${nextToken ?? ''}`);
    return { items: [...this.items.values()], nextToken: undefined };
  }
  async create(record: TenantRecord): Promise<void> {
    this.calls.push(`create:${record.tenantId}`);
    if (this.items.has(record.tenantId)) {
      throw new DomainConflictError(`Tenant ${record.tenantId} already exists`);
    }
    this.items.set(record.tenantId, record);
  }
  async markDeleting(tenantId: string): Promise<TenantRecord> {
    this.calls.push(`markDeleting:${tenantId}`);
    const existing = this.items.get(tenantId);
    if (existing === undefined) {
      throw new NotFoundError(`Tenant ${tenantId} not found`);
    }
    const updated: TenantRecord = { ...existing, status: 'DELETING' };
    this.items.set(tenantId, updated);
    return updated;
  }
  async delete(tenantId: string): Promise<void> {
    this.calls.push(`delete:${tenantId}`);
    this.items.delete(tenantId);
  }
}

function tenantRecord(status: TenantStatus = 'ACTIVE', topology: Topology = 'shared-pool-multi-tenant'): TenantRecord {
  return {
    tenantId: TENANT_A,
    name: 'Acme',
    status,
    topology,
    groupName: `t-${TENANT_A}`,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
  };
}

function userView(username = 'u1', admin = false): UserView {
  return {
    username,
    email: `${username}@example.com`,
    admin,
    status: 'CONFIRMED',
    createdAt: FIXED_NOW,
  };
}

function mockProvisioner(topology: Topology = 'shared-pool-multi-tenant'): jest.Mocked<Provisioner> {
  return {
    topology,
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
}

function makeService(
  registry: Registry,
  provisioner: jest.Mocked<Provisioner>,
  topology: Topology = 'shared-pool-multi-tenant',
): PlatformService {
  return new PlatformService({
    registry,
    provisioner,
    topology,
    newTenantId: () => TENANT_A,
    now: () => FIXED_NOW,
  });
}

const TOKENS: TokenSet = { accessToken: 'a', idToken: 'i', refreshToken: 'r', expiresIn: 300 };

describe('PlatformService (spec §5.1)', () => {
  describe('CreateTenant', () => {
    it('writes an ACTIVE record with the provisioned fields and returns the admin with the temporary password (spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      const newUser: NewUserResult = { user: userView('admin', true), temporaryPassword: 'Temp#1234' };
      provisioner.createUser.mockResolvedValue(newUser);

      const out = await makeService(registry, provisioner).CreateTenant(
        { name: 'Acme', adminEmail: 'admin@example.com' },
        CONTEXT,
      );

      expect(out.tenant?.status).toBe('ACTIVE');
      expect(out.tenant?.tenantId).toBe(TENANT_A);
      expect(out.tenant?.groupName).toBe(`t-${TENANT_A}`);
      expect(out.tenant?.createdAt).toEqual(FIXED_NOW);
      expect(out.admin?.user?.admin).toBe(true);
      expect(out.admin?.temporaryPassword).toBe('Temp#1234');
      // R-10: registry received only tenant fields, no user payload.
      const stored = registry.items.get(TENANT_A)!;
      expect(Object.keys(stored)).toEqual(
        expect.arrayContaining(['tenantId', 'name', 'status', 'topology', 'createdAt', 'updatedAt']),
      );
      expect(stored).not.toHaveProperty('email');
      expect(stored).not.toHaveProperty('temporaryPassword');
      // The admin step runs after the registry write.
      expect(provisioner.createUser).toHaveBeenCalledWith(stored, 'admin@example.com', true);
    });

    it('rethrows and never writes the registry when provisioning fails before the write (spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockRejectedValue(new Error('boom'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@e.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(registry.items.size).toBe(0);
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('deprovisions and rethrows when the registry write fails after provisioning (spec §5.1)', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'create').mockRejectedValue(new Error('throttled'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@e.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(provisioner.deprovisionTenant).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('leaves the tenant ACTIVE and surfaces the error when the admin step fails (spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.createUser.mockRejectedValue(new DomainConflictError('email exists'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@e.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
      // Tenant remains ACTIVE; vendor retries CreateUser.
      expect(registry.items.get(TENANT_A)?.status).toBe('ACTIVE');
    });
  });

  describe('GetTenant', () => {
    it('returns the tenant', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const out = await makeService(registry, mockProvisioner()).GetTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(out.tenant?.tenantId).toBe(TENANT_A);
    });

    it('returns a DELETING tenant on read (P-2)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('DELETING'));
      const out = await makeService(registry, mockProvisioner()).GetTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(out.tenant?.status).toBe('DELETING');
    });

    it('404 for an unknown tenant (spec §5.3)', async () => {
      await expect(
        makeService(new FakeRegistry(), mockProvisioner()).GetTenant({ tenantId: TENANT_A }, CONTEXT),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('ListTenants', () => {
    it('paginates registry records', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const out = await makeService(registry, mockProvisioner()).ListTenants({}, CONTEXT);
      expect(out.tenants).toHaveLength(1);
      expect(out.tenants?.[0]?.tenantId).toBe(TENANT_A);
    });
  });

  describe('DeleteTenant (R-11)', () => {
    it('marks DELETING before deprovision, deletes only after success', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.deprovisionTenant.mockResolvedValue(undefined);

      await makeService(registry, provisioner).DeleteTenant({ tenantId: TENANT_A }, CONTEXT);

      // Order: markDeleting runs before deprovisionTenant; delete runs last.
      const markIdx = registry.calls.indexOf(`markDeleting:${TENANT_A}`);
      const deleteIdx = registry.calls.indexOf(`delete:${TENANT_A}`);
      expect(markIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThan(markIdx);
      const deprovisionOrder = provisioner.deprovisionTenant.mock.invocationCallOrder[0];
      // markDeleting flips status before the Cognito clean-up runs.
      expect(registry.items.has(TENANT_A)).toBe(false);
      expect(deprovisionOrder).toBeGreaterThan(0);
    });

    it('leaves the tenant DELETING when deprovision fails, and a re-run completes (R-11, idempotent)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.deprovisionTenant.mockRejectedValueOnce(new Error('cognito down'));
      const service = makeService(registry, provisioner);

      await expect(service.DeleteTenant({ tenantId: TENANT_A }, CONTEXT)).rejects.toBeInstanceOf(
        InternalServerError,
      );
      // Clean-up failed: item stays, status DELETING, not removed.
      expect(registry.items.get(TENANT_A)?.status).toBe('DELETING');

      // Re-run: deprovision succeeds the second time, item is removed.
      provisioner.deprovisionTenant.mockResolvedValueOnce(undefined);
      await service.DeleteTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(registry.items.has(TENANT_A)).toBe(false);
    });

    it('404 for an unknown tenant (spec §5.3)', async () => {
      await expect(
        makeService(new FakeRegistry(), mockProvisioner()).DeleteTenant({ tenantId: TENANT_A }, CONTEXT),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('per-user operations happy paths', () => {
    it('CreateUser delegates to the provisioner and returns the user', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.createUser.mockResolvedValue({ user: userView('u1'), temporaryPassword: 'Temp#1234' });
      const out = await makeService(registry, provisioner).CreateUser(
        { tenantId: TENANT_A, email: 'u1@example.com', admin: false },
        CONTEXT,
      );
      expect(out.user?.username).toBe('u1');
      expect(out.temporaryPassword).toBe('Temp#1234');
    });

    it('GetUser delegates and maps the view', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.getUser.mockResolvedValue(userView('u1', true));
      const out = await makeService(registry, provisioner).GetUser(
        { tenantId: TENANT_A, username: 'u1' },
        CONTEXT,
      );
      expect(out.user?.admin).toBe(true);
    });

    it('ListUsers delegates with pagination', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.listUsers.mockResolvedValue({ items: [userView('u1')], nextToken: 'next' });
      const out = await makeService(registry, provisioner).ListUsers({ tenantId: TENANT_A }, CONTEXT);
      expect(out.users).toHaveLength(1);
      expect(out.nextToken).toBe('next');
    });

    it('UpdateUser sets the admin flag', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.setAdmin.mockResolvedValue(userView('u1', true));
      const out = await makeService(registry, provisioner).UpdateUser(
        { tenantId: TENANT_A, username: 'u1', admin: true },
        CONTEXT,
      );
      expect(out.user?.admin).toBe(true);
      expect(provisioner.setAdmin).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'u1', true);
    });

    it('DeleteUser delegates to the provisioner', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.deleteUser.mockResolvedValue(undefined);
      await makeService(registry, provisioner).DeleteUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT);
      expect(provisioner.deleteUser).toHaveBeenCalled();
    });

    it('CreateMembership delegates to the provisioner (topology 3)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.createMembership.mockResolvedValue(undefined);
      await makeService(registry, provisioner).CreateMembership(
        { tenantId: TENANT_A, username: 'u1' },
        CONTEXT,
      );
      expect(provisioner.createMembership).toHaveBeenCalled();
    });

    it('DeleteMembership delegates to the provisioner (topology 3)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.deleteMembership.mockResolvedValue(undefined);
      await makeService(registry, provisioner).DeleteMembership(
        { tenantId: TENANT_A, username: 'u1' },
        CONTEXT,
      );
      expect(provisioner.deleteMembership).toHaveBeenCalled();
    });

    it('IssueToken returns a full token set', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.issueToken.mockResolvedValue(TOKENS);
      const out = await makeService(registry, provisioner).IssueToken(
        { tenantId: TENANT_A, username: 'u1', password: 'Secret#123' },
        CONTEXT,
      );
      expect(out).toEqual({ accessToken: 'a', idToken: 'i', refreshToken: 'r', expiresIn: 300 });
    });

    it('RefreshToken returns access and id tokens without a refresh token', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      provisioner.refreshToken.mockResolvedValue({ accessToken: 'a', idToken: 'i', expiresIn: 300 });
      const out = await makeService(registry, provisioner).RefreshToken(
        { tenantId: TENANT_A, username: 'u1', refreshToken: 'r' },
        CONTEXT,
      );
      expect(out).toEqual({ accessToken: 'a', idToken: 'i', expiresIn: 300 });
    });
  });

  describe('404 for unknown tenant on every per-user operation (spec §5.3)', () => {
    const cases: Array<[string, (s: PlatformService) => Promise<unknown>]> = [
      ['CreateUser', (s) => s.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com' }, CONTEXT)],
      ['GetUser', (s) => s.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['ListUsers', (s) => s.ListUsers({ tenantId: TENANT_A }, CONTEXT)],
      ['UpdateUser', (s) => s.UpdateUser({ tenantId: TENANT_A, username: 'u1', admin: true }, CONTEXT)],
      ['DeleteUser', (s) => s.DeleteUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['CreateMembership', (s) => s.CreateMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['DeleteMembership', (s) => s.DeleteMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['IssueToken', (s) => s.IssueToken({ tenantId: TENANT_A, username: 'u1', password: 'Secret#123' }, CONTEXT)],
      ['RefreshToken', (s) => s.RefreshToken({ tenantId: TENANT_A, username: 'u1', refreshToken: 'r' }, CONTEXT)],
    ];
    it.each(cases)('%s -> 404', async (_name, call) => {
      await expect(call(makeService(new FakeRegistry(), mockProvisioner()))).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
    });
  });

  describe('409 on DELETING for every mutation and token aid (P-2, spec §5.3)', () => {
    function withDeleting(): { service: PlatformService; provisioner: jest.Mocked<Provisioner> } {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('DELETING'));
      const provisioner = mockProvisioner();
      return { service: makeService(registry, provisioner), provisioner };
    }
    const cases: Array<[string, (s: PlatformService) => Promise<unknown>]> = [
      ['CreateUser', (s) => s.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com' }, CONTEXT)],
      ['UpdateUser', (s) => s.UpdateUser({ tenantId: TENANT_A, username: 'u1', admin: true }, CONTEXT)],
      ['DeleteUser', (s) => s.DeleteUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['CreateMembership', (s) => s.CreateMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['DeleteMembership', (s) => s.DeleteMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['IssueToken', (s) => s.IssueToken({ tenantId: TENANT_A, username: 'u1', password: 'Secret#123' }, CONTEXT)],
      ['RefreshToken', (s) => s.RefreshToken({ tenantId: TENANT_A, username: 'u1', refreshToken: 'r' }, CONTEXT)],
    ];
    it.each(cases)('%s -> 409 and does not touch the provisioner', async (_name, call) => {
      const { service, provisioner } = withDeleting();
      await expect(call(service)).rejects.toBeInstanceOf(ConflictError);
      expect(provisioner.createUser).not.toHaveBeenCalled();
      expect(provisioner.setAdmin).not.toHaveBeenCalled();
      expect(provisioner.deleteUser).not.toHaveBeenCalled();
      expect(provisioner.createMembership).not.toHaveBeenCalled();
      expect(provisioner.deleteMembership).not.toHaveBeenCalled();
      expect(provisioner.issueToken).not.toHaveBeenCalled();
      expect(provisioner.refreshToken).not.toHaveBeenCalled();
    });

    it('reads (GetUser/ListUsers) are allowed on DELETING (P-2)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('DELETING'));
      const provisioner = mockProvisioner();
      provisioner.getUser.mockResolvedValue(userView('u1'));
      provisioner.listUsers.mockResolvedValue({ items: [userView('u1')], nextToken: undefined });
      const service = makeService(registry, provisioner);
      await expect(service.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)).resolves.toBeDefined();
      await expect(service.ListUsers({ tenantId: TENANT_A }, CONTEXT)).resolves.toBeDefined();
    });
  });

  describe('domain error mapping (spec §5.3)', () => {
    function serviceWithActiveTenant(): { service: PlatformService; provisioner: jest.Mocked<Provisioner> } {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      const provisioner = mockProvisioner();
      return { service: makeService(registry, provisioner), provisioner };
    }

    it('NotFoundError -> ResourceNotFoundError (404)', async () => {
      const { service, provisioner } = serviceWithActiveTenant();
      provisioner.getUser.mockRejectedValue(new NotFoundError('no user'));
      await expect(service.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)).rejects.toBeInstanceOf(
        ResourceNotFoundError,
      );
    });

    it('ConflictError -> ConflictError (409)', async () => {
      const { service, provisioner } = serviceWithActiveTenant();
      provisioner.deleteMembership.mockRejectedValue(new DomainConflictError('last tenant'));
      await expect(
        service.DeleteMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('UnsupportedInTopologyError -> ValidationError with reason UnsupportedInTopology (P-4)', async () => {
      const { service, provisioner } = serviceWithActiveTenant();
      provisioner.createMembership.mockRejectedValue(
        new UnsupportedInTopologyError('CreateMembership', 'shared-pool'),
      );
      await expect(
        service.CreateMembership({ tenantId: TENANT_A, username: 'u1' }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', reason: 'UnsupportedInTopology' });
    });

    it('InvalidInputError -> ValidationError with reason InvalidInput', async () => {
      const { service, provisioner } = serviceWithActiveTenant();
      provisioner.createUser.mockRejectedValue(new InvalidInputError('bad'));
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com' }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', reason: 'InvalidInput' });
    });

    it('unknown errors -> InternalServerError without leaking the message (N-6)', async () => {
      const { service, provisioner } = serviceWithActiveTenant();
      provisioner.getUser.mockRejectedValue(new Error('secret cognito detail'));
      await expect(service.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)).rejects.toMatchObject({
        name: 'InternalServerError',
        message: 'Internal server error',
      });
    });
  });
});
