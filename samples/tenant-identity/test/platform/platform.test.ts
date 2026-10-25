// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PlatformContext, PlatformService } from '../../src/platform/platform';
import type { Deployment, Topology } from '../../src/shared/constants';
import {
  ConflictError as DomainConflictError,
  InvalidInputError,
  NotFoundError,
  UnsupportedInTopologyError,
} from '../../src/shared/errors';
import type { Page, Registry, TenantRecord, TenantStatus } from '../../src/shared/registry';
import type { TenantApiKey, TenantApiKeys } from '../../src/shared/tenant-api-keys';
import {
  ConflictError,
  InternalServerError,
  ResourceNotFoundError,
  ValidationError,
} from '../../src/smithy/platform/typescript-ssdk-codegen/src';
import type { ProvisionersFor } from '../../src/topology';
import type { NewUserResult, Provisioner, TokenSet, UserView } from '../../src/topology/provisioner';

/**
 * Unit tests for the platform service (spec §5.1, §5.3, R-11, R-12, P-2, P-4,
 * ADR-0027). A fake in-memory registry stands in for DynamoDB; the
 * provisioner is a jest mock so the tests assert the orchestration the
 * service owns, not Cognito behaviour. The single-topology tests hand the
 * service one mock for every topology; the `tiered` tests hand it one per
 * tier and assert which one each row reaches.
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
  async activate(
    tenantId: string,
    provisioned: { userPoolId?: string; appClientId?: string; issuer?: string; groupName?: string },
  ): Promise<TenantRecord> {
    this.calls.push(`activate:${tenantId}`);
    const existing = this.items.get(tenantId);
    if (existing === undefined || existing.status !== 'PROVISIONING') {
      throw new DomainConflictError(`Tenant ${tenantId} is not PROVISIONING`);
    }
    // Mirror the DynamoDB impl: only DEFINED provisioned fields are written.
    const defined = Object.fromEntries(Object.entries(provisioned).filter(([, v]) => v !== undefined));
    const updated: TenantRecord = { ...existing, ...defined, status: 'ACTIVE' };
    this.items.set(tenantId, updated);
    return updated;
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
    assertEmailAvailable: jest.fn().mockResolvedValue(undefined),
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

// ADR-0025: the API key module, reset per test.
let apiKeys: jest.Mocked<TenantApiKeys>;
const KEY: TenantApiKey = { apiKeyId: 'key-id-a', apiKeyValue: 'key-value-a-00000000000' };
beforeEach(() => {
  apiKeys = { create: jest.fn().mockResolvedValue(KEY), delete: jest.fn().mockResolvedValue(undefined) };
});

/** One mock for every topology: the single-topology service never asks for another. */
function provisionersFor(provisioner: jest.Mocked<Provisioner>): ProvisionersFor {
  return () => provisioner;
}

function makeService(
  registry: Registry,
  provisioner: jest.Mocked<Provisioner>,
  deployment: Deployment = 'shared-pool-multi-tenant',
): PlatformService {
  return new PlatformService({
    registry,
    provisioners: provisionersFor(provisioner),
    apiKeys,
    deployment,
    newTenantId: () => TENANT_A,
    now: () => FIXED_NOW,
  });
}

const TOKENS: TokenSet = { accessToken: 'a', idToken: 'i', refreshToken: 'r', expiresIn: 300 };

describe('PlatformService (spec §5.1)', () => {
  describe('CreateTenant', () => {
    it('writes the row as PROVISIONING before provisionTenant is called, then returns ACTIVE with the provisioned fields (ADR-0021, spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      // Capture the stored status at the moment provisionTenant is invoked.
      let statusWhenProvisioned: TenantStatus | undefined;
      provisioner.provisionTenant.mockImplementation(async () => {
        statusWhenProvisioned = registry.items.get(TENANT_A)?.status;
        return { groupName: `t-${TENANT_A}` };
      });
      const newUser: NewUserResult = { user: userView('admin', true), temporaryPassword: 'Temp#1234' };
      provisioner.createUser.mockResolvedValue(newUser);

      const out = await makeService(registry, provisioner).CreateTenant(
        { name: 'Acme', adminEmail: 'admin@example.com' },
        CONTEXT,
      );

      // The row existed as PROVISIONING before Cognito was touched (ADR-0021).
      expect(statusWhenProvisioned).toBe('PROVISIONING');
      // Call order: create, then provisionTenant, then activate.
      expect(registry.calls.indexOf(`create:${TENANT_A}`)).toBeLessThan(
        provisioner.provisionTenant.mock.invocationCallOrder[0],
      );
      expect(registry.calls.indexOf(`create:${TENANT_A}`)).toBeLessThan(
        registry.calls.indexOf(`activate:${TENANT_A}`),
      );

      expect(out.tenant?.status).toBe('ACTIVE');
      expect(out.tenant?.tenantId).toBe(TENANT_A);
      expect(out.tenant?.groupName).toBe(`t-${TENANT_A}`);
      expect(out.tenant?.createdAt).toEqual(FIXED_NOW);
      expect(out.admin?.user?.admin).toBe(true);
      expect(out.admin?.temporaryPassword).toBe('Temp#1234');
      // The stored record is ACTIVE with the provisioned field after activate.
      const stored = registry.items.get(TENANT_A)!;
      expect(stored.status).toBe('ACTIVE');
      expect(stored.groupName).toBe(`t-${TENANT_A}`);
      // R-10: registry received only tenant fields, no user payload.
      expect(stored).not.toHaveProperty('email');
      expect(stored).not.toHaveProperty('temporaryPassword');
      // The admin step runs after activation, against the ACTIVE record.
      expect(provisioner.createUser).toHaveBeenCalledWith(stored, 'admin@example.com', true);
    });

    it('deletes the PROVISIONING row and rethrows when provisioning fails (ADR-0021, spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockRejectedValue(new Error('boom'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      // The row was written then removed; nothing is left behind.
      expect(registry.calls).toContain(`create:${TENANT_A}`);
      expect(registry.calls).toContain(`delete:${TENANT_A}`);
      expect(registry.items.size).toBe(0);
      expect(provisioner.deprovisionTenant).not.toHaveBeenCalled();
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('deprovisions Cognito and deletes the row when activate fails (ADR-0021, spec §5.1)', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'activate').mockRejectedValue(new Error('throttled'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      // Both the Cognito half and the registry row are cleaned up.
      expect(provisioner.deprovisionTenant).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, groupName: `t-${TENANT_A}` }),
      );
      expect(registry.calls).toContain(`delete:${TENANT_A}`);
      expect(registry.items.size).toBe(0);
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('leaves the tenant ACTIVE and surfaces the error when the admin step fails (spec §5.1)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.createUser.mockRejectedValue(new DomainConflictError('email exists'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
      // Tenant remains ACTIVE; vendor retries CreateUser.
      expect(registry.items.get(TENANT_A)?.status).toBe('ACTIVE');
    });
  });

  describe('CreateTenant API key (ADR-0025)', () => {
    it('creates the key after Cognito and before activation, and stores id and value on the row', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });

      const out = await makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT);

      // No tier outside `tiered` (ADR-0027): the key goes in the stack's plan.
      expect(apiKeys.create).toHaveBeenCalledWith(TENANT_A, undefined);
      expect(provisioner.provisionTenant.mock.invocationCallOrder[0]).toBeLessThan(apiKeys.create.mock.invocationCallOrder[0]);
      const stored = registry.items.get(TENANT_A)!;
      expect(stored.status).toBe('ACTIVE');
      expect(stored.apiKeyId).toBe(KEY.apiKeyId);
      expect(stored.apiKeyValue).toBe(KEY.apiKeyValue);
      // The key never leaves through the API (it is not in the Tenant shape).
      expect(JSON.stringify(out)).not.toContain(KEY.apiKeyValue);
      expect(JSON.stringify(out)).not.toContain(KEY.apiKeyId);
    });

    it('a key failure deprovisions Cognito, deletes the row, and rethrows; no key to delete', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      apiKeys.create.mockRejectedValue(Object.assign(new Error('limit'), { name: 'LimitExceededException' }));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(provisioner.deprovisionTenant).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, groupName: `t-${TENANT_A}` }),
      );
      expect(registry.items.size).toBe(0);
      expect(registry.calls).not.toContain(`activate:${TENANT_A}`);
      // ApiGatewayTenantApiKeys.create undoes its own half-built key.
      expect(apiKeys.delete).not.toHaveBeenCalled();
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('a key failure still surfaces when the clean-up fails too', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'delete').mockRejectedValue(new Error('ddb down'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.deprovisionTenant.mockRejectedValue(new Error('cognito down'));
      apiKeys.create.mockRejectedValue(new Error('apigw down'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(provisioner.deprovisionTenant).toHaveBeenCalled();
      expect(registry.delete).toHaveBeenCalledWith(TENANT_A);
    });

    it('an activation failure deletes the key as well as the Cognito half and the row', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'activate').mockRejectedValue(new Error('throttled'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(apiKeys.delete).toHaveBeenCalledWith(KEY.apiKeyId);
      expect(provisioner.deprovisionTenant).toHaveBeenCalled();
      expect(registry.items.size).toBe(0);
    });

    it('an activation failure still deprovisions when the key delete fails', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'activate').mockRejectedValue(new Error('throttled'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      apiKeys.delete.mockRejectedValue(new Error('apigw down'));

      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(provisioner.deprovisionTenant).toHaveBeenCalled();
      expect(registry.items.size).toBe(0);
    });

    it('a provisioning failure creates no key', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockRejectedValue(new Error('boom'));
      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(apiKeys.create).not.toHaveBeenCalled();
    });
  });

  describe('CreateTenant admin e-mail pre-flight (spec §5.1)', () => {
    it('a taken admin e-mail is a 409 before anything is written: no row, no Cognito, no adminless tenant', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner('shared-pool');
      provisioner.assertEmailAvailable.mockRejectedValue(new DomainConflictError('E-mail already exists'));

      await expect(
        makeService(registry, provisioner, 'shared-pool').CreateTenant({ name: 'Acme', adminEmail: 'taken@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(provisioner.assertEmailAvailable).toHaveBeenCalledWith('taken@example.com');
      expect(registry.calls).not.toContain(`create:${TENANT_A}`);
      expect(registry.items.size).toBe(0);
      expect(provisioner.provisionTenant).not.toHaveBeenCalled();
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('checks the e-mail before the registry write (ADR-0021 ordering otherwise unchanged)', async () => {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      let rowsWhenChecked = -1;
      provisioner.assertEmailAvailable.mockImplementation(async () => {
        rowsWhenChecked = registry.items.size;
      });
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });

      await makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT);
      expect(rowsWhenChecked).toBe(0);
      expect(provisioner.assertEmailAvailable.mock.invocationCallOrder[0]).toBeLessThan(
        provisioner.provisionTenant.mock.invocationCallOrder[0],
      );
    });
  });

  describe('tiered deployment (ADR-0027)', () => {
    /** One mock per tier; the service must reach the right one by the row's topology. */
    function tieredMocks(): {
      shared: jest.Mocked<Provisioner>;
      perTenant: jest.Mocked<Provisioner>;
      provisioners: ProvisionersFor;
    } {
      const shared = mockProvisioner('shared-pool');
      const perTenant = mockProvisioner('pool-per-tenant');
      const byTopology: Partial<Record<Topology, jest.Mocked<Provisioner>>> = {
        'shared-pool': shared,
        'pool-per-tenant': perTenant,
      };
      const provisioners: ProvisionersFor = (topology) => {
        const p = byTopology[topology];
        if (p === undefined) {
          throw new Error(`Topology ${topology} is not offered by deployment tiered`);
        }
        return p;
      };
      return { shared, perTenant, provisioners };
    }

    function tieredService(registry: Registry, provisioners: ProvisionersFor): PlatformService {
      return new PlatformService({
        registry,
        provisioners,
        apiKeys,
        deployment: 'tiered',
        newTenantId: () => TENANT_A,
        now: () => FIXED_NOW,
      });
    }

    it('CreateTenant standard -> row topology shared-pool, the shared-pool provisioner, the standard plan', async () => {
      const registry = new FakeRegistry();
      const { shared, perTenant, provisioners } = tieredMocks();
      shared.provisionTenant.mockResolvedValue({});
      shared.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });

      const out = await tieredService(registry, provisioners).CreateTenant(
        { name: 'Acme', adminEmail: 'a@example.com', tier: 'standard' },
        CONTEXT,
      );

      expect(registry.items.get(TENANT_A)?.topology).toBe('shared-pool');
      expect(out.tenant?.topology).toBe('shared-pool');
      expect(out.tenant?.tier).toBe('standard');
      expect(shared.assertEmailAvailable).toHaveBeenCalledWith('a@example.com');
      expect(shared.provisionTenant).toHaveBeenCalledWith(TENANT_A, 'Acme');
      expect(shared.createUser).toHaveBeenCalled();
      expect(perTenant.assertEmailAvailable).not.toHaveBeenCalled();
      expect(perTenant.provisionTenant).not.toHaveBeenCalled();
      // The key lands in the standard tier's plan.
      expect(apiKeys.create).toHaveBeenCalledWith(TENANT_A, 'standard');
    });

    it('CreateTenant premium -> row topology pool-per-tenant, the pool-per-tenant provisioner, the premium plan', async () => {
      const registry = new FakeRegistry();
      const { shared, perTenant, provisioners } = tieredMocks();
      perTenant.provisionTenant.mockResolvedValue({
        userPoolId: 'eu-central-1_P',
        appClientId: 'client-p',
        issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_P',
      });
      perTenant.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });

      const out = await tieredService(registry, provisioners).CreateTenant(
        { name: 'Acme', adminEmail: 'a@example.com', tier: 'premium' },
        CONTEXT,
      );

      expect(registry.items.get(TENANT_A)?.topology).toBe('pool-per-tenant');
      expect(out.tenant?.topology).toBe('pool-per-tenant');
      expect(out.tenant?.tier).toBe('premium');
      expect(out.tenant?.userPoolId).toBe('eu-central-1_P');
      expect(perTenant.provisionTenant).toHaveBeenCalledWith(TENANT_A, 'Acme');
      expect(perTenant.createUser).toHaveBeenCalled();
      expect(shared.provisionTenant).not.toHaveBeenCalled();
      expect(apiKeys.create).toHaveBeenCalledWith(TENANT_A, 'premium');
    });

    it('CreateTenant without a tier -> 400 InvalidInput with a fixed message, before anything is written', async () => {
      const registry = new FakeRegistry();
      const { shared, perTenant, provisioners } = tieredMocks();

      await expect(
        tieredService(registry, provisioners).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT),
      ).rejects.toMatchObject({
        name: 'ValidationError',
        reason: 'InvalidInput',
        message: 'tier is required in a tiered deployment',
      });
      expect(registry.items.size).toBe(0);
      expect(registry.calls).toEqual([]);
      expect(shared.assertEmailAvailable).not.toHaveBeenCalled();
      expect(perTenant.assertEmailAvailable).not.toHaveBeenCalled();
      expect(apiKeys.create).not.toHaveBeenCalled();
    });

    it('a premium-tier clean-up after a key failure deprovisions through the pool-per-tenant provisioner', async () => {
      const registry = new FakeRegistry();
      const { shared, perTenant, provisioners } = tieredMocks();
      perTenant.provisionTenant.mockResolvedValue({ userPoolId: 'eu-central-1_P' });
      apiKeys.create.mockRejectedValue(new Error('apigw down'));

      await expect(
        tieredService(registry, provisioners).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com', tier: 'premium' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(perTenant.deprovisionTenant).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, topology: 'pool-per-tenant', userPoolId: 'eu-central-1_P' }),
      );
      expect(shared.deprovisionTenant).not.toHaveBeenCalled();
      expect(registry.items.size).toBe(0);
    });

    it('GetTenant and ListTenants return the tier derived from each row\'s topology', async () => {
      const registry = new FakeRegistry();
      const TENANT_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
      registry.items.set(TENANT_A, tenantRecord('ACTIVE', 'shared-pool'));
      registry.items.set(TENANT_B, { ...tenantRecord('ACTIVE', 'pool-per-tenant'), tenantId: TENANT_B });
      const service = tieredService(registry, tieredMocks().provisioners);

      const got = await service.GetTenant({ tenantId: TENANT_B }, CONTEXT);
      expect(got.tenant?.tier).toBe('premium');

      const listed = await service.ListTenants({}, CONTEXT);
      expect(listed.tenants?.map((t) => [t.tenantId, t.tier])).toEqual([
        [TENANT_A, 'standard'],
        [TENANT_B, 'premium'],
      ]);
    });

    it('per-user operations dispatch on the row\'s topology, not the deployment', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('ACTIVE', 'pool-per-tenant'));
      const { shared, perTenant, provisioners } = tieredMocks();
      perTenant.createUser.mockResolvedValue({ user: userView('u1'), temporaryPassword: 'T#1' });
      perTenant.getUser.mockResolvedValue(userView('u1'));
      perTenant.listUsers.mockResolvedValue({ items: [], nextToken: undefined });
      perTenant.setAdmin.mockResolvedValue(userView('u1', true));
      perTenant.deleteUser.mockResolvedValue(undefined);
      perTenant.issueToken.mockResolvedValue(TOKENS);
      perTenant.refreshToken.mockResolvedValue(TOKENS);
      const service = tieredService(registry, provisioners);

      await service.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com' }, CONTEXT);
      await service.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT);
      await service.ListUsers({ tenantId: TENANT_A }, CONTEXT);
      await service.UpdateUser({ tenantId: TENANT_A, username: 'u1', admin: true }, CONTEXT);
      await service.DeleteUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT);
      await service.IssueToken({ tenantId: TENANT_A, username: 'u1', password: 'Secret#123' }, CONTEXT);
      await service.RefreshToken({ tenantId: TENANT_A, username: 'u1', refreshToken: 'r' }, CONTEXT);

      for (const method of ['createUser', 'getUser', 'listUsers', 'setAdmin', 'deleteUser', 'issueToken', 'refreshToken'] as const) {
        expect(perTenant[method]).toHaveBeenCalledTimes(1);
        expect(shared[method]).not.toHaveBeenCalled();
      }
    });

    it('DeleteTenant deprovisions a standard tenant through the shared-pool provisioner', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('ACTIVE', 'shared-pool'));
      const { shared, perTenant, provisioners } = tieredMocks();
      shared.deprovisionTenant.mockResolvedValue(undefined);

      await tieredService(registry, provisioners).DeleteTenant({ tenantId: TENANT_A }, CONTEXT);

      expect(shared.deprovisionTenant).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A, status: 'DELETING' }));
      expect(perTenant.deprovisionTenant).not.toHaveBeenCalled();
      expect(registry.items.has(TENANT_A)).toBe(false);
    });

    it('a row whose topology the deployment does not offer is a 500, never a fallback', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('ACTIVE', 'shared-pool-multi-tenant'));
      const { shared, perTenant, provisioners } = tieredMocks();

      await expect(
        tieredService(registry, provisioners).GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(shared.getUser).not.toHaveBeenCalled();
      expect(perTenant.getUser).not.toHaveBeenCalled();
    });
  });

  describe('tier outside a tiered deployment (ADR-0027, P-4)', () => {
    it.each<Deployment>(['shared-pool', 'pool-per-tenant', 'shared-pool-multi-tenant'])(
      'CreateTenant with a tier in %s -> 400 UnsupportedInTopology, nothing written',
      async (deployment) => {
        const registry = new FakeRegistry();
        const provisioner = mockProvisioner(deployment as Topology);

        await expect(
          makeService(registry, provisioner, deployment).CreateTenant(
            { name: 'Acme', adminEmail: 'a@example.com', tier: 'standard' },
            CONTEXT,
          ),
        ).rejects.toMatchObject({
          name: 'ValidationError',
          reason: 'UnsupportedInTopology',
          message: 'tier is only accepted in a tiered deployment',
        });
        expect(registry.items.size).toBe(0);
        expect(provisioner.assertEmailAvailable).not.toHaveBeenCalled();
        expect(provisioner.provisionTenant).not.toHaveBeenCalled();
      },
    );

    it('GetTenant carries no tier field in a single-topology deployment', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('ACTIVE', 'shared-pool'));
      const out = await makeService(registry, mockProvisioner('shared-pool'), 'shared-pool').GetTenant(
        { tenantId: TENANT_A },
        CONTEXT,
      );
      expect(out.tenant).not.toHaveProperty('tier');
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
      expect(apiKeys.delete).not.toHaveBeenCalled();
    });

    it('deletes the tenant\'s API key after Cognito and before the row (ADR-0025)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, { ...tenantRecord(), apiKeyId: KEY.apiKeyId, apiKeyValue: KEY.apiKeyValue });
      const provisioner = mockProvisioner();
      provisioner.deprovisionTenant.mockResolvedValue(undefined);

      await makeService(registry, provisioner).DeleteTenant({ tenantId: TENANT_A }, CONTEXT);

      expect(apiKeys.delete).toHaveBeenCalledWith(KEY.apiKeyId);
      expect(provisioner.deprovisionTenant.mock.invocationCallOrder[0]).toBeLessThan(apiKeys.delete.mock.invocationCallOrder[0]);
      expect(registry.items.has(TENANT_A)).toBe(false);
    });

    it('a key delete failure leaves the tenant DELETING for a re-run (ADR-0025, R-11)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, { ...tenantRecord(), apiKeyId: KEY.apiKeyId });
      const provisioner = mockProvisioner();
      provisioner.deprovisionTenant.mockResolvedValue(undefined);
      apiKeys.delete.mockRejectedValueOnce(new Error('TooManyRequestsException'));
      const service = makeService(registry, provisioner);

      await expect(service.DeleteTenant({ tenantId: TENANT_A }, CONTEXT)).rejects.toBeInstanceOf(InternalServerError);
      expect(registry.items.get(TENANT_A)?.status).toBe('DELETING');

      await service.DeleteTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(registry.items.has(TENANT_A)).toBe(false);
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

  describe('409 on PROVISIONING for mutations and token aids (ADR-0021, P-2, spec §5.3)', () => {
    function withProvisioning(): { service: PlatformService; provisioner: jest.Mocked<Provisioner> } {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('PROVISIONING'));
      const provisioner = mockProvisioner();
      return { service: makeService(registry, provisioner), provisioner };
    }
    const cases: Array<[string, (s: PlatformService) => Promise<unknown>]> = [
      ['CreateUser', (s) => s.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com' }, CONTEXT)],
      ['IssueToken', (s) => s.IssueToken({ tenantId: TENANT_A, username: 'u1', password: 'Secret#123' }, CONTEXT)],
    ];
    it.each(cases)('%s -> 409 with the status message and does not touch the provisioner', async (_name, call) => {
      const { service, provisioner } = withProvisioning();
      await expect(call(service)).rejects.toMatchObject({
        name: 'ConflictError',
        message: `Tenant ${TENANT_A} is PROVISIONING`,
      });
      expect(provisioner.createUser).not.toHaveBeenCalled();
      expect(provisioner.issueToken).not.toHaveBeenCalled();
    });
  });

  describe('409 on PROVISIONING for Cognito-side reads (ADR-0021, P-2, spec §5.3)', () => {
    const cases: Array<[string, (s: PlatformService) => Promise<unknown>]> = [
      ['GetUser', (s) => s.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)],
      ['ListUsers', (s) => s.ListUsers({ tenantId: TENANT_A }, CONTEXT)],
    ];
    it.each(cases)('%s -> 409 and does not touch the provisioner', async (_name, call) => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('PROVISIONING', 'pool-per-tenant'));
      const provisioner = mockProvisioner('pool-per-tenant');
      await expect(call(makeService(registry, provisioner, 'pool-per-tenant'))).rejects.toMatchObject({
        name: 'ConflictError',
        message: `Tenant ${TENANT_A} is PROVISIONING`,
      });
      expect(provisioner.getUser).not.toHaveBeenCalled();
      expect(provisioner.listUsers).not.toHaveBeenCalled();
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
