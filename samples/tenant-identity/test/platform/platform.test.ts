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
import type { ActivatedFields, Page, Registry, ScopeRecord, TenantRecord, TenantStatus } from '../../src/shared/registry';
import type { TenantApiKey, TenantApiKeys } from '../../src/shared/tenant-api-keys';
import {
  ConflictError,
  CreateTenantInput,
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
  /** The scope catalogue rows (ADR-0034), by name. */
  readonly scopes = new Map<string, ScopeRecord>();
  readonly calls: string[] = [];

  /** Registers catalogue scopes directly, as a backend's PutScope would. */
  withScopes(...names: string[]): this {
    for (const name of names) {
      this.scopes.set(name, { name, owner: name.split('/')[0], createdAt: FIXED_NOW.toISOString() });
    }
    return this;
  }

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
  async activate(tenantId: string, provisioned: ActivatedFields): Promise<TenantRecord> {
    this.calls.push(`activate:${tenantId}`);
    const existing = this.items.get(tenantId);
    if (existing === undefined || existing.status !== 'PROVISIONING') {
      throw new DomainConflictError(`Tenant ${tenantId} is not PROVISIONING`);
    }
    // Mirror the DynamoDB impl: only DEFINED provisioned fields are written
    // (the first-admin slot among them, ADR-0032).
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
  async claimFirstAdmin(tenantId: string, email: string): Promise<void> {
    this.calls.push(`claimFirstAdmin:${tenantId}`);
    // Mirror the DynamoDB impl: one conditional write, 404 if gone, 409 if held.
    const existing = this.items.get(tenantId);
    if (existing === undefined) {
      throw new NotFoundError(`Tenant ${tenantId} not found`);
    }
    if (existing.firstAdminEmail !== undefined) {
      throw new DomainConflictError(`Tenant ${tenantId} already has a first admin`);
    }
    this.items.set(tenantId, { ...existing, firstAdminEmail: email });
  }
  async confirmFirstAdmin(tenantId: string, email: string): Promise<void> {
    this.calls.push(`confirmFirstAdmin:${tenantId}`);
    // Mirror the DynamoDB impl: empty or ours -> (re)written; else 404 / 409.
    const existing = this.items.get(tenantId);
    if (existing === undefined) {
      throw new NotFoundError(`Tenant ${tenantId} not found`);
    }
    if (existing.firstAdminEmail !== undefined && existing.firstAdminEmail !== email) {
      throw new DomainConflictError(`Tenant ${tenantId} already has a first admin`);
    }
    this.items.set(tenantId, { ...existing, firstAdminEmail: email });
  }
  async releaseFirstAdmin(tenantId: string, email: string): Promise<void> {
    this.calls.push(`releaseFirstAdmin:${tenantId}`);
    // Mirror the DynamoDB impl: only the holder's e-mail releases; else no-op.
    const existing = this.items.get(tenantId);
    if (existing === undefined || existing.firstAdminEmail !== email) {
      return;
    }
    const { firstAdminEmail: _released, ...rest } = existing;
    this.items.set(tenantId, rest);
  }
  async delete(tenantId: string): Promise<void> {
    this.calls.push(`delete:${tenantId}`);
    this.items.delete(tenantId);
  }
  async updateTenantScopes(tenantId: string, scopes: readonly string[]): Promise<TenantRecord> {
    this.calls.push(`updateTenantScopes:${tenantId}`);
    const existing = this.items.get(tenantId);
    if (existing === undefined) {
      throw new NotFoundError(`Tenant ${tenantId} not found`);
    }
    const updated: TenantRecord = { ...existing, scopes: [...scopes] };
    this.items.set(tenantId, updated);
    return updated;
  }
  async putScope(scope: Omit<ScopeRecord, 'createdAt'>): Promise<ScopeRecord> {
    this.calls.push(`putScope:${scope.name}`);
    const existing = this.scopes.get(scope.name);
    const written: ScopeRecord = { ...scope, createdAt: existing?.createdAt ?? FIXED_NOW.toISOString() };
    this.scopes.set(scope.name, written);
    return written;
  }
  async getScope(name: string): Promise<ScopeRecord | undefined> {
    return this.scopes.get(name);
  }
  async listScopes(): Promise<Page<ScopeRecord>> {
    return { items: [...this.scopes.values()] };
  }
  async listScopeNames(): Promise<string[]> {
    this.calls.push('listScopeNames');
    return [...this.scopes.keys()];
  }
  async deleteScope(name: string): Promise<void> {
    this.calls.push(`deleteScope:${name}`);
    this.scopes.delete(name);
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
    setScopes: jest.fn(),
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
      // The admin step runs after activation, against the ACTIVE record, and
      // holds the first-admin slot (ADR-0032, M-R-9).
      expect(provisioner.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, status: 'ACTIVE', groupName: `t-${TENANT_A}` }),
        'admin@example.com',
        true,
      );
      expect(stored.firstAdminEmail).toBe('admin@example.com');
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
      // Tenant remains ACTIVE; vendor retries CreateUser {firstAdmin: true},
      // so the slot the failed admin step claimed is released (M-R-8).
      expect(registry.items.get(TENANT_A)?.status).toBe('ACTIVE');
      expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      expect(registry.calls).toContain(`releaseFirstAdmin:${TENANT_A}`);
    });
  });

  describe('CreateTenant with a caller-supplied tenantId (ADR-0029, mounting spec M-R-2, M-R-3)', () => {
    const SUPPLIED = '01HZXK5V3P9Q7R2T4W6Y8A0BCD';

    function ready(): { registry: FakeRegistry; provisioner: jest.Mocked<Provisioner> } {
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${SUPPLIED}` });
      provisioner.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'T#1' });
      return { registry, provisioner };
    }

    it('uses the supplied id for the row, the provisioner, the key and the response; the generator is not called', async () => {
      const { registry, provisioner } = ready();
      const newTenantId = jest.fn(() => TENANT_A);
      const service = new PlatformService({
        registry,
        provisioners: provisionersFor(provisioner),
        apiKeys,
        deployment: 'shared-pool-multi-tenant',
        newTenantId,
        now: () => FIXED_NOW,
      });

      const out = await service.CreateTenant({ tenantId: SUPPLIED, name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT);

      expect(out.tenant?.tenantId).toBe(SUPPLIED);
      expect(registry.items.has(SUPPLIED)).toBe(true);
      expect(registry.items.has(TENANT_A)).toBe(false);
      expect(newTenantId).not.toHaveBeenCalled();
      expect(provisioner.provisionTenant).toHaveBeenCalledWith(SUPPLIED, 'Acme');
      expect(apiKeys.create).toHaveBeenCalledWith(SUPPLIED, undefined);
    });

    it('an existing id is a 409 from the conditional registry write and changes nothing (M-R-2)', async () => {
      const { registry, provisioner } = ready();
      const before = { ...tenantRecord(), tenantId: SUPPLIED, firstAdminEmail: 'first@example.com' };
      registry.items.set(SUPPLIED, before);

      await expect(
        makeService(registry, provisioner).CreateTenant({ tenantId: SUPPLIED, name: 'Replay', adminEmail: 'b@example.com' }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);

      // The write was attempted (the condition decides, not a read) and refused.
      expect(registry.calls).toContain(`create:${SUPPLIED}`);
      expect(registry.items.get(SUPPLIED)).toEqual(before);
      expect(registry.items.size).toBe(1);
      // Nothing was built or torn down in Cognito or API Gateway.
      expect(provisioner.provisionTenant).not.toHaveBeenCalled();
      expect(provisioner.deprovisionTenant).not.toHaveBeenCalled();
      expect(provisioner.createUser).not.toHaveBeenCalled();
      expect(apiKeys.create).not.toHaveBeenCalled();
      expect(registry.calls).not.toContain(`delete:${SUPPLIED}`);
    });

    it('without tenantId the generated id is used as before', async () => {
      const { registry, provisioner } = ready();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      const out = await makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT);
      expect(out.tenant?.tenantId).toBe(TENANT_A);
      expect(registry.items.has(TENANT_A)).toBe(true);
    });

    it('the generated model validator rejects a bad id with the TenantId pattern before the service runs (M-R-3)', () => {
      // The pattern lives on the TenantId shape the member reuses, so the
      // same ULID rule applies to the optional input as to every path label.
      const failures = CreateTenantInput.validate({ tenantId: 'not-a-ulid', name: 'Acme', adminEmail: 'a@example.com' });
      expect(failures).toEqual([
        expect.objectContaining({ path: '/tenantId', constraintType: 'pattern', constraintValues: '^[0-9A-HJKMNP-TV-Z]{26}$' }),
      ]);
      expect(CreateTenantInput.validate({ tenantId: SUPPLIED, name: 'Acme', adminEmail: 'a@example.com' })).toEqual([]);
      // Lower-case and the excluded letters (I, L, O, U) are refused too.
      expect(CreateTenantInput.validate({ tenantId: SUPPLIED.toLowerCase(), name: 'Acme', adminEmail: 'a@example.com' })).toHaveLength(1);
      expect(CreateTenantInput.validate({ tenantId: '01HZXK5V3P9Q7R2T4W6Y8A0BIL', name: 'Acme', adminEmail: 'a@example.com' })).toHaveLength(1);
    });
  });

  describe('first-admin slot (ADR-0032, mounting spec M-R-8, M-R-9)', () => {
    const FIRST = 'success+admin@simulator.amazonses.com';
    const OTHER = 'other@example.com';

    function withActiveTenant(firstAdminEmail?: string): {
      registry: FakeRegistry;
      provisioner: jest.Mocked<Provisioner>;
      service: PlatformService;
    } {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, { ...tenantRecord(), ...(firstAdminEmail === undefined ? {} : { firstAdminEmail }) });
      const provisioner = mockProvisioner();
      return { registry, provisioner, service: makeService(registry, provisioner) };
    }

    it('CreateUser {firstAdmin: true} claims the slot, then creates an admin -> 201 with the slot held', async () => {
      const { registry, provisioner, service } = withActiveTenant();
      let slotWhenCreated: string | undefined;
      provisioner.createUser.mockImplementation(async () => {
        slotWhenCreated = registry.items.get(TENANT_A)?.firstAdminEmail;
        return { user: { ...userView('sub-1', true), email: FIRST }, temporaryPassword: 'T#1' };
      });

      const out = await service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT);

      // The claim precedes the Cognito call (M-R-8), and implies admin.
      expect(slotWhenCreated).toBe(FIRST);
      expect(provisioner.createUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), FIRST, true);
      expect(out.user?.admin).toBe(true);
      expect(out.temporaryPassword).toBe('T#1');
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
    });

    it('firstAdmin: true with admin: false still creates an admin (firstAdmin implies admin)', async () => {
      const { provisioner, service } = withActiveTenant();
      provisioner.createUser.mockResolvedValue({ user: userView('sub-1', true), temporaryPassword: 'T#1' });
      await service.CreateUser({ tenantId: TENANT_A, email: FIRST, admin: false, firstAdmin: true }, CONTEXT);
      expect(provisioner.createUser).toHaveBeenCalledWith(expect.anything(), FIRST, true);
    });

    it('a taken slot is a 409 before any Cognito call, and the holder is unchanged', async () => {
      const { registry, provisioner, service } = withActiveTenant(FIRST);

      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ConflictError', message: `Tenant ${TENANT_A} already has a first admin` });

      expect(provisioner.createUser).not.toHaveBeenCalled();
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      // Nothing was released either: the failed claim touched nothing.
      expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
    });

    it('a replay with the same e-mail is also a 409 (the slot, not Cognito uniqueness, decides)', async () => {
      const { provisioner, service } = withActiveTenant(FIRST);
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(provisioner.createUser).not.toHaveBeenCalled();
    });

    it('a Cognito failure after the claim releases the slot and surfaces the ORIGINAL error', async () => {
      const { registry, provisioner, service } = withActiveTenant();
      provisioner.createUser.mockRejectedValue(new DomainConflictError('E-mail already exists'));

      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ConflictError', message: 'E-mail already exists' });

      expect(registry.calls).toEqual(expect.arrayContaining([`claimFirstAdmin:${TENANT_A}`, `releaseFirstAdmin:${TENANT_A}`]));
      expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      // The slot is free again: a retry succeeds.
      provisioner.createUser.mockResolvedValue({ user: userView('sub-1', true), temporaryPassword: 'T#1' });
      await expect(service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT)).resolves.toBeDefined();
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
    });

    it('an unknown Cognito failure after the claim releases the slot and is a 500 without the message (N-6)', async () => {
      const { registry, provisioner, service } = withActiveTenant();
      provisioner.createUser.mockRejectedValue(new Error('secret cognito detail'));
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
      ).rejects.toMatchObject({ name: 'InternalServerError', message: 'Internal server error' });
      expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
    });

    it('the original error still surfaces when the release itself fails', async () => {
      const { registry, provisioner, service } = withActiveTenant();
      provisioner.createUser.mockRejectedValue(new DomainConflictError('E-mail already exists'));
      jest.spyOn(registry, 'releaseFirstAdmin').mockRejectedValue(new Error('ddb down'));
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ConflictError', message: 'E-mail already exists' });
      expect(registry.releaseFirstAdmin).toHaveBeenCalledWith(TENANT_A, FIRST);
    });

    it('a second plain admin is allowed while the slot is held (many admins, one first admin)', async () => {
      const { registry, provisioner, service } = withActiveTenant(FIRST);
      provisioner.createUser.mockResolvedValue({ user: { ...userView('sub-2', true), email: OTHER }, temporaryPassword: 'T#2' });

      const out = await service.CreateUser({ tenantId: TENANT_A, email: OTHER, admin: true }, CONTEXT);

      expect(out.user?.admin).toBe(true);
      expect(provisioner.createUser).toHaveBeenCalledWith(expect.anything(), OTHER, true);
      expect(registry.calls).not.toContain(`claimFirstAdmin:${TENANT_A}`);
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
    });

    it('CreateUser without firstAdmin never touches the slot (unchanged behaviour)', async () => {
      const { registry, provisioner, service } = withActiveTenant();
      provisioner.createUser.mockResolvedValue({ user: userView('u1'), temporaryPassword: 'T#1' });
      await service.CreateUser({ tenantId: TENANT_A, email: 'u1@example.com', admin: false }, CONTEXT);
      await service.CreateUser({ tenantId: TENANT_A, email: 'u2@example.com', firstAdmin: false }, CONTEXT);
      expect(registry.calls.filter((c) => c.startsWith('claimFirstAdmin') || c.startsWith('releaseFirstAdmin'))).toEqual([]);
      expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
    });

    it('CreateTenant\'s admin holds the slot, written by activate() in the same update that makes the row ACTIVE (M-R-9)', async () => {
      const registry = new FakeRegistry();
      const activate = jest.spyOn(registry, 'activate');
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      let slotWhenCreated: string | undefined;
      let statusWhenCreated: TenantStatus | undefined;
      provisioner.createUser.mockImplementation(async () => {
        slotWhenCreated = registry.items.get(TENANT_A)?.firstAdminEmail;
        statusWhenCreated = registry.items.get(TENANT_A)?.status;
        return { user: { ...userView('sub-1', true), email: FIRST }, temporaryPassword: 'T#1' };
      });

      const out = await makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: FIRST }, CONTEXT);

      // The slot rides on the activate write: one update flips the status AND
      // claims the slot, so there is no ACTIVE-with-empty-slot instant.
      expect(activate).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({ firstAdminEmail: FIRST }));
      expect(registry.calls).not.toContain(`claimFirstAdmin:${TENANT_A}`);
      expect(slotWhenCreated).toBe(FIRST);
      expect(statusWhenCreated).toBe('ACTIVE');
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      // A replay of the first-admin step is now a 409, with no second admin.
      await expect(
        makeService(registry, provisioner).CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(provisioner.createUser).toHaveBeenCalledTimes(1);
      // The slot never leaves through the API.
      expect(JSON.stringify(out)).not.toContain('firstAdminEmail');
    });

    it('a CreateUser {firstAdmin: true} racing the tail of CreateTenant is the one that gets the 409; CreateTenant keeps its slot and returns 201', async () => {
      // Before the fix the slot was claimed in a second write after
      // activate(); a concurrent first-admin claim in between won, and
      // CreateTenant answered 409 for a tenant it had just created.
      const registry = new FakeRegistry();
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      const service = makeService(registry, provisioner);
      let racerOutcome: unknown;
      provisioner.createUser.mockImplementation(async (_tenant, email) => {
        if (email === FIRST) {
          // The row is ACTIVE; a racer tries to claim the slot right now.
          racerOutcome = await service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT).catch((e) => e);
        }
        return { user: { ...userView('sub-1', true), email }, temporaryPassword: 'T#1' };
      });

      const out = await service.CreateTenant({ name: 'Acme', adminEmail: FIRST }, CONTEXT);

      expect(out.tenant?.status).toBe('ACTIVE');
      expect(out.admin?.user?.email).toBe(FIRST);
      expect(racerOutcome).toBeInstanceOf(ConflictError);
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      // Only the tenant's own admin reached Cognito.
      expect(provisioner.createUser).toHaveBeenCalledTimes(1);
      expect(provisioner.createUser).toHaveBeenCalledWith(expect.anything(), FIRST, true);
    });

    it('an activation failure leaves no slot behind (the slot is part of the row that is deleted)', async () => {
      const registry = new FakeRegistry();
      jest.spyOn(registry, 'activate').mockRejectedValue(new Error('throttled'));
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: FIRST }, CONTEXT),
      ).rejects.toBeInstanceOf(InternalServerError);
      expect(registry.items.size).toBe(0);
      expect(provisioner.createUser).not.toHaveBeenCalled();
      expect(registry.calls.filter((c) => c.startsWith('claimFirstAdmin') || c.startsWith('releaseFirstAdmin'))).toEqual([]);
    });

    describe('re-asserting the claim after Cognito (the stale-release race)', () => {
      /**
       * The interleaving: CreateUser {firstAdmin: true, email: A} claims the
       * slot; while Cognito is still creating A, a DeleteUser(A) arrives,
       * finds no such user, takes the slot for stale and releases it. The
       * create then completes. Without the confirm write the tenant would
       * have an admin and an empty slot, and a second first admin could be
       * made.
       */
      function staleReleaseDuringCreate(service: PlatformService, provisioner: jest.Mocked<Provisioner>): Promise<unknown>[] {
        const deleteOutcomes: Promise<unknown>[] = [];
        provisioner.createUser.mockImplementation(async (_tenant, email) => {
          // The racing operator delete, for the e-mail being created.
          provisioner.getUser.mockRejectedValueOnce(new NotFoundError('User not found in tenant'));
          deleteOutcomes.push(service.DeleteUser({ tenantId: TENANT_A, username: email }, CONTEXT).catch((e) => e));
          await deleteOutcomes[deleteOutcomes.length - 1];
          return { user: { ...userView('sub-1', true), email }, temporaryPassword: 'T#1' };
        });
        return deleteOutcomes;
      }

      it('claim -> DeleteUser(A) 404 releases the slot -> create completes -> the confirm write puts A back; 201, one first admin', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        const deletes = staleReleaseDuringCreate(service, provisioner);

        const out = await service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT);

        expect(out.user?.email).toBe(FIRST);
        await expect(deletes[0]).resolves.toBeInstanceOf(ResourceNotFoundError);
        // The release did happen (the slot was empty for a moment) ...
        expect(registry.calls).toContain(`releaseFirstAdmin:${TENANT_A}`);
        // ... and the confirm write closed the window: the slot is A's again.
        expect(registry.calls.indexOf(`releaseFirstAdmin:${TENANT_A}`)).toBeLessThan(registry.calls.indexOf(`confirmFirstAdmin:${TENANT_A}`));
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        // So a second first admin is still a 409 (§6.4).
        await expect(
          service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(provisioner.deleteUser).not.toHaveBeenCalled();
      });

      it('... and when another first admin B claimed the emptied slot meanwhile, A\'s user is undone and A gets 409; B keeps the slot', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        provisioner.deleteUser.mockResolvedValue(undefined);
        provisioner.createUser.mockImplementation(async (_tenant, email) => {
          if (email === FIRST) {
            // Stale release of A's claim by a racing DeleteUser(A) ...
            provisioner.getUser.mockRejectedValueOnce(new NotFoundError('User not found in tenant'));
            await service.DeleteUser({ tenantId: TENANT_A, username: FIRST }, CONTEXT).catch(() => undefined);
            // ... then B wins the empty slot and is created before A finishes.
            await service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT);
          }
          return { user: { ...userView(email === FIRST ? 'sub-a' : 'sub-b', true), email }, temporaryPassword: 'T#' };
        });

        await expect(
          service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
        ).rejects.toMatchObject({ name: 'ConflictError', message: `Tenant ${TENANT_A} already has a first admin` });

        // A's just-created Cognito user was removed; B's stands with the slot.
        expect(provisioner.deleteUser).toHaveBeenCalledTimes(1);
        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'sub-a');
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(OTHER);
      });

      it('a failed undo of A\'s user is logged and the 409 still surfaces (B keeps the slot)', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        // Pre-claimed by B after A's claim was released: simulate by making
        // the confirm write see B's e-mail.
        jest.spyOn(registry, 'confirmFirstAdmin').mockRejectedValue(new DomainConflictError(`Tenant ${TENANT_A} already has a first admin`));
        provisioner.createUser.mockResolvedValue({ user: { ...userView('sub-a', true), email: FIRST }, temporaryPassword: 'T#' });
        provisioner.deleteUser.mockRejectedValue(new Error('cognito down'));

        await expect(
          service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
        ).rejects.toBeInstanceOf(ConflictError);
        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.anything(), 'sub-a');
      });

      it('a vanished row at the confirm write (DeleteTenant raced the create) undoes the user and is a 404', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        provisioner.createUser.mockImplementation(async () => {
          registry.items.delete(TENANT_A);
          return { user: { ...userView('sub-a', true), email: FIRST }, temporaryPassword: 'T#' };
        });
        provisioner.deleteUser.mockResolvedValue(undefined);
        await expect(
          service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.anything(), 'sub-a');
      });

      it('any other confirm failure is a 500 and leaves the user in place (the slot is, barring the race, still ours)', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        jest.spyOn(registry, 'confirmFirstAdmin').mockRejectedValue(new Error('ddb down'));
        provisioner.createUser.mockResolvedValue({ user: { ...userView('sub-a', true), email: FIRST }, temporaryPassword: 'T#' });
        await expect(
          service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT),
        ).rejects.toBeInstanceOf(InternalServerError);
        expect(provisioner.deleteUser).not.toHaveBeenCalled();
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      });

      it('the happy path confirms once, after Cognito, with the same e-mail', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        const confirm = jest.spyOn(registry, 'confirmFirstAdmin');
        provisioner.createUser.mockResolvedValue({ user: { ...userView('sub-a', true), email: FIRST }, temporaryPassword: 'T#' });
        await service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith(TENANT_A, FIRST);
        expect(provisioner.createUser.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
      });

      it('CreateTenant runs the same confirm after its admin is created', async () => {
        const registry = new FakeRegistry();
        const provisioner = mockProvisioner();
        provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
        const service = makeService(registry, provisioner);
        const deletes = staleReleaseDuringCreate(service, provisioner);

        const out = await service.CreateTenant({ name: 'Acme', adminEmail: FIRST }, CONTEXT);

        expect(out.admin?.user?.email).toBe(FIRST);
        await expect(deletes[0]).resolves.toBeInstanceOf(ResourceNotFoundError);
        expect(registry.calls).toContain(`confirmFirstAdmin:${TENANT_A}`);
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      });
    });

    it('firstAdmin: true for an existing pool user (topology 3) -> 201, slot held, no temporaryPassword', async () => {
      // Mount spec §7.1 step 5: a 201 without temporaryPassword means an
      // existing pool user was added as the tenant's first admin; the mount
      // parks nothing, and the slot is held all the same.
      const { registry, provisioner, service } = withActiveTenant();
      provisioner.createUser.mockResolvedValue({ user: { ...userView('existing-sub', true), email: FIRST, status: 'CONFIRMED' } });

      const out = await service.CreateUser({ tenantId: TENANT_A, email: FIRST, firstAdmin: true }, CONTEXT);

      expect(out.user?.admin).toBe(true);
      expect(out.user?.username).toBe('existing-sub');
      expect(out.temporaryPassword).toBeUndefined();
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      // The slot is held: a second first admin is refused.
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    describe('DeleteUser (M-R-9)', () => {
      it('deleting the holder (by Cognito username) releases the slot after the Cognito delete', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
        let slotWhenDeleted: string | undefined;
        provisioner.deleteUser.mockImplementation(async () => {
          slotWhenDeleted = registry.items.get(TENANT_A)?.firstAdminEmail;
        });

        await service.DeleteUser({ tenantId: TENANT_A, username: 'sub-1' }, CONTEXT);

        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'sub-1');
        // Still held while Cognito ran; released only after it succeeded.
        expect(slotWhenDeleted).toBe(FIRST);
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
        // The vendor can now replace the lost admin.
        provisioner.createUser.mockResolvedValue({ user: userView('sub-9', true), temporaryPassword: 'T#9' });
        await expect(service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT)).resolves.toBeDefined();
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(OTHER);
      });

      it('deleting the holder by e-mail releases the slot too', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
        provisioner.deleteUser.mockResolvedValue(undefined);
        await service.DeleteUser({ tenantId: TENANT_A, username: FIRST }, CONTEXT);
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      });

      it('deleting another user leaves the slot held', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-2', true), email: OTHER });
        provisioner.deleteUser.mockResolvedValue(undefined);

        await service.DeleteUser({ tenantId: TENANT_A, username: 'sub-2' }, CONTEXT);

        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.anything(), 'sub-2');
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('a failed Cognito delete keeps the slot (the holder still exists)', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
        provisioner.deleteUser.mockRejectedValue(new Error('cognito down'));
        await expect(service.DeleteUser({ tenantId: TENANT_A, username: 'sub-1' }, CONTEXT)).rejects.toBeInstanceOf(InternalServerError);
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      });

      it('with no slot held, DeleteUser does not read the user first (unchanged behaviour)', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        provisioner.deleteUser.mockResolvedValue(undefined);
        await service.DeleteUser({ tenantId: TENANT_A, username: 'sub-2' }, CONTEXT);
        expect(provisioner.getUser).not.toHaveBeenCalled();
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('a stale slot (holder already gone from Cognito) is released by DeleteUser of the holder\'s e-mail, which still 404s', async () => {
        // The tenant admin\'s door deleted the first admin; it cannot write
        // the registry (M-14), so the slot outlived the user.
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockRejectedValue(new NotFoundError('User not found in tenant'));

        await expect(service.DeleteUser({ tenantId: TENANT_A, username: FIRST }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);

        expect(provisioner.deleteUser).not.toHaveBeenCalled();
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
        // Recovery: a new first admin can now be created.
        provisioner.createUser.mockResolvedValue({ user: userView('sub-9', true), temporaryPassword: 'T#9' });
        await expect(service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT)).resolves.toBeDefined();
      });

      it('a 404 for a name that is not the holder leaves the slot alone', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockRejectedValue(new NotFoundError('User not found in tenant'));
        await expect(service.DeleteUser({ tenantId: TENANT_A, username: OTHER }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('a stale slot named by the gone holder\'s UUID username (pool-per-tenant) is a plain 404 and the slot is kept; the e-mail releases it', async () => {
        // In pool-per-tenant the Cognito username is a UUID and the e-mail an
        // alias; the slot stores the E-MAIL. With the holder gone there is
        // nothing left to map the UUID back to the e-mail, so only the
        // e-mail form of DeleteUser releases the stale slot (pinned here so
        // the behaviour is documented, not accidental).
        const UUID = '7a4d2c9e-1b3f-4e8a-9c6d-0f1e2d3c4b5a';
        const registry = new FakeRegistry();
        registry.items.set(TENANT_A, { ...tenantRecord('ACTIVE', 'pool-per-tenant'), userPoolId: 'eu-central-1_P', firstAdminEmail: FIRST });
        const provisioner = mockProvisioner('pool-per-tenant');
        provisioner.getUser.mockRejectedValue(new NotFoundError('User not found in tenant'));
        const service = makeService(registry, provisioner, 'pool-per-tenant');

        await expect(service.DeleteUser({ tenantId: TENANT_A, username: UUID }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(provisioner.deleteUser).not.toHaveBeenCalled();
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);

        // The documented recovery: name the holder's e-mail.
        await expect(service.DeleteUser({ tenantId: TENANT_A, username: FIRST }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      });

      it('a live holder in pool-per-tenant is released whether named by UUID or by e-mail (compared on the user\'s e-mail)', async () => {
        const UUID = '7a4d2c9e-1b3f-4e8a-9c6d-0f1e2d3c4b5a';
        const registry = new FakeRegistry();
        registry.items.set(TENANT_A, { ...tenantRecord('ACTIVE', 'pool-per-tenant'), userPoolId: 'eu-central-1_P', firstAdminEmail: FIRST });
        const provisioner = mockProvisioner('pool-per-tenant');
        provisioner.getUser.mockResolvedValue({ ...userView(UUID, true), email: FIRST });
        provisioner.deleteUser.mockResolvedValue(undefined);

        await makeService(registry, provisioner, 'pool-per-tenant').DeleteUser({ tenantId: TENANT_A, username: UUID }, CONTEXT);

        expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.anything(), UUID);
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      });
    });

    describe('DeleteMembership (M-R-9, topology 3)', () => {
      it('removing the holder\'s membership releases the slot after the Cognito removal, symmetric to DeleteUser', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
        let slotWhenRemoved: string | undefined;
        provisioner.deleteMembership.mockImplementation(async () => {
          slotWhenRemoved = registry.items.get(TENANT_A)?.firstAdminEmail;
        });

        await service.DeleteMembership({ tenantId: TENANT_A, username: 'sub-1' }, CONTEXT);

        expect(provisioner.deleteMembership).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'sub-1');
        expect(slotWhenRemoved).toBe(FIRST);
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
        // The vendor can now replace the lost first admin.
        provisioner.createUser.mockResolvedValue({ user: userView('sub-9', true), temporaryPassword: 'T#9' });
        await expect(service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT)).resolves.toBeDefined();
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(OTHER);
      });

      it('removing another user\'s membership leaves the slot held', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-2', true), email: OTHER });
        provisioner.deleteMembership.mockResolvedValue(undefined);
        await service.DeleteMembership({ tenantId: TENANT_A, username: 'sub-2' }, CONTEXT);
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('a refused removal (last tenant, 409) keeps the slot: the holder is still a member', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockResolvedValue({ ...userView('sub-1', true), email: FIRST });
        provisioner.deleteMembership.mockRejectedValue(new DomainConflictError('Cannot remove the user from their last tenant'));
        await expect(service.DeleteMembership({ tenantId: TENANT_A, username: 'sub-1' }, CONTEXT)).rejects.toBeInstanceOf(ConflictError);
        expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('with no slot held, DeleteMembership does not read the user first (unchanged behaviour)', async () => {
        const { registry, provisioner, service } = withActiveTenant();
        provisioner.deleteMembership.mockResolvedValue(undefined);
        await service.DeleteMembership({ tenantId: TENANT_A, username: 'sub-2' }, CONTEXT);
        expect(provisioner.getUser).not.toHaveBeenCalled();
        expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
      });

      it('a stale slot is released by DeleteMembership naming the gone holder\'s e-mail, which still 404s', async () => {
        const { registry, provisioner, service } = withActiveTenant(FIRST);
        provisioner.getUser.mockRejectedValue(new NotFoundError('User not found in tenant'));
        await expect(service.DeleteMembership({ tenantId: TENANT_A, username: FIRST }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(provisioner.deleteMembership).not.toHaveBeenCalled();
        expect(registry.items.get(TENANT_A)).not.toHaveProperty('firstAdminEmail');
      });
    });

    it('UpdateUser {admin: false} on the holder keeps the slot: the slot follows presence in the tenant, not the admin flag', async () => {
      // Releasing on demotion would let a second first admin be created while
      // the first still exists (the duplicate §6.4 forbids). The holder can
      // be re-promoted; the slot moves only when they leave the tenant.
      const { registry, provisioner, service } = withActiveTenant(FIRST);
      provisioner.setAdmin.mockResolvedValue({ ...userView('sub-1', false), email: FIRST });
      await service.UpdateUser({ tenantId: TENANT_A, username: 'sub-1', admin: false }, CONTEXT);
      expect(registry.items.get(TENANT_A)?.firstAdminEmail).toBe(FIRST);
      expect(registry.calls.filter((c) => c.startsWith('releaseFirstAdmin') || c.startsWith('claimFirstAdmin'))).toEqual([]);
      await expect(
        service.CreateUser({ tenantId: TENANT_A, email: OTHER, firstAdmin: true }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('GetTenant and ListTenants never expose firstAdminEmail (mounting spec §10 step 4)', async () => {
      const { service } = withActiveTenant(FIRST);
      const got = await service.GetTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(got.tenant).not.toHaveProperty('firstAdminEmail');
      expect(JSON.stringify(got)).not.toContain(FIRST);
      const listed = await service.ListTenants({}, CONTEXT);
      expect(JSON.stringify(listed)).not.toContain('firstAdminEmail');
      expect(JSON.stringify(listed)).not.toContain(FIRST);
    });

    it('DeleteTenant removes the row, slot included, with no separate release', async () => {
      const { registry, provisioner, service } = withActiveTenant(FIRST);
      provisioner.deprovisionTenant.mockResolvedValue(undefined);
      await service.DeleteTenant({ tenantId: TENANT_A }, CONTEXT);
      expect(registry.items.has(TENANT_A)).toBe(false);
      expect(registry.calls).not.toContain(`releaseFirstAdmin:${TENANT_A}`);
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

  // -------------------------------------------------------------------
  // Scope catalogue (ADR-0034) and tenant entitlement (ADR-0035)
  // -------------------------------------------------------------------

  describe('scope catalogue (ADR-0034)', () => {
    it('PutScope registers a scope, derives the owner from the name and is idempotent', async () => {
      const registry = new FakeRegistry();
      const service = makeService(registry, mockProvisioner());
      const first = await service.PutScope({ scope: 'billing/read', description: 'Read invoices' }, CONTEXT);
      expect(first.scope).toEqual({ name: 'billing/read', owner: 'billing', description: 'Read invoices', createdAt: FIXED_NOW });
      const again = await service.PutScope({ scope: 'billing/read' }, CONTEXT);
      expect(again.scope?.createdAt).toEqual(FIXED_NOW);
      expect(again.scope).not.toHaveProperty('description');
      expect(registry.scopes.size).toBe(1);
    });

    it('PutScope refuses the reserved owner tenant-admin with 400 invalid_scope and writes nothing', async () => {
      const registry = new FakeRegistry();
      await expect(
        makeService(registry, mockProvisioner()).PutScope({ scope: 'tenant-admin/billing' }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', reason: 'InvalidInput', message: expect.stringMatching(/^invalid_scope/) });
      expect(registry.scopes.size).toBe(0);
    });

    it('GetScope returns the row, 404 when absent', async () => {
      const registry = new FakeRegistry().withScopes('billing/read');
      const service = makeService(registry, mockProvisioner());
      expect((await service.GetScope({ scope: 'billing/read' }, CONTEXT)).scope?.owner).toBe('billing');
      await expect(service.GetScope({ scope: 'billing/none' }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('ListScopes lists the catalogue', async () => {
      const registry = new FakeRegistry().withScopes('a/b', 'c/d');
      const out = await makeService(registry, mockProvisioner()).ListScopes({}, CONTEXT);
      expect(out.scopes?.map((s) => s.name)).toEqual(['a/b', 'c/d']);
    });

    it('DeleteScope removes the row, is idempotent, and leaves tenant rows that name it alone (ADR-0035)', async () => {
      const registry = new FakeRegistry().withScopes('a/b');
      registry.items.set(TENANT_A, { ...tenantRecord(), scopes: ['a/b'] });
      const service = makeService(registry, mockProvisioner());
      await service.DeleteScope({ scope: 'a/b' }, CONTEXT);
      await service.DeleteScope({ scope: 'a/b' }, CONTEXT);
      expect(registry.scopes.size).toBe(0);
      expect(registry.items.get(TENANT_A)?.scopes).toEqual(['a/b']);
      // The tenant still lists it; the trigger intersects it away (§8.1).
      expect((await service.GetTenant({ tenantId: TENANT_A }, CONTEXT)).tenant?.scopes).toEqual(['a/b']);
    });
  });

  describe('tenant entitlement (ADR-0035)', () => {
    function readyProvisioner(): jest.Mocked<Provisioner> {
      const provisioner = mockProvisioner();
      provisioner.provisionTenant.mockResolvedValue({ groupName: `t-${TENANT_A}` });
      provisioner.createUser.mockResolvedValue({ user: userView('admin', true), temporaryPassword: 'Temp#1234' });
      return provisioner;
    }

    it('CreateTenant without scopes writes an empty entitlement (fail closed)', async () => {
      const registry = new FakeRegistry().withScopes('a/b');
      const out = await makeService(registry, readyProvisioner()).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com' }, CONTEXT);
      expect(out.tenant?.scopes).toEqual([]);
      expect(registry.items.get(TENANT_A)?.scopes).toEqual([]);
      expect(out.admin?.user?.scopes).toEqual([]);
    });

    it('CreateTenant with scopes stores them and the admin holds them', async () => {
      const registry = new FakeRegistry().withScopes('a/b', 'c/d');
      const out = await makeService(registry, readyProvisioner()).CreateTenant(
        { name: 'Acme', adminEmail: 'a@example.com', scopes: ['c/d', 'a/b'] },
        CONTEXT,
      );
      expect(out.tenant?.scopes).toEqual(['c/d', 'a/b']);
      expect(out.admin?.user?.scopes).toEqual(['c/d', 'a/b']);
    });

    it.each([
      ['an unregistered scope', ['a/b', 'x/y']],
      ['a duplicate', ['a/b', 'a/b']],
      ['the admin scope', ['tenant-admin/users']],
    ])('CreateTenant with %s is 400 invalid_scope before anything is written', async (_label, scopes) => {
      const registry = new FakeRegistry().withScopes('a/b');
      const provisioner = readyProvisioner();
      await expect(
        makeService(registry, provisioner).CreateTenant({ name: 'Acme', adminEmail: 'a@example.com', scopes }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', message: expect.stringMatching(/^invalid_scope/) });
      expect(registry.items.size).toBe(0);
      expect(provisioner.provisionTenant).not.toHaveBeenCalled();
    });

    it('UpdateTenant replaces the entitlement on an ACTIVE tenant', async () => {
      const registry = new FakeRegistry().withScopes('a/b', 'c/d');
      registry.items.set(TENANT_A, { ...tenantRecord(), scopes: ['a/b'] });
      const out = await makeService(registry, mockProvisioner()).UpdateTenant({ tenantId: TENANT_A, scopes: ['c/d'] }, CONTEXT);
      expect(out.tenant?.scopes).toEqual(['c/d']);
      expect(registry.items.get(TENANT_A)?.scopes).toEqual(['c/d']);
      expect((await makeService(registry, mockProvisioner()).ListTenants({}, CONTEXT)).tenants?.[0].scopes).toEqual(['c/d']);
    });

    it('UpdateTenant to an empty list is allowed (the tenant then holds nothing)', async () => {
      const registry = new FakeRegistry().withScopes('a/b');
      registry.items.set(TENANT_A, { ...tenantRecord(), scopes: ['a/b'] });
      const out = await makeService(registry, mockProvisioner()).UpdateTenant({ tenantId: TENANT_A, scopes: [] }, CONTEXT);
      expect(out.tenant?.scopes).toEqual([]);
    });

    it('UpdateTenant refuses a scope that left the catalogue with 400 invalid_scope and changes nothing', async () => {
      const registry = new FakeRegistry().withScopes('a/b');
      registry.items.set(TENANT_A, { ...tenantRecord(), scopes: ['a/b'] });
      await expect(
        makeService(registry, mockProvisioner()).UpdateTenant({ tenantId: TENANT_A, scopes: ['a/b', 'gone/x'] }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', message: expect.stringMatching(/^invalid_scope/) });
      expect(registry.items.get(TENANT_A)?.scopes).toEqual(['a/b']);
    });

    it('UpdateTenant is 404 for an unknown tenant and 409 for a non-ACTIVE one', async () => {
      const registry = new FakeRegistry().withScopes('a/b');
      const service = makeService(registry, mockProvisioner());
      await expect(service.UpdateTenant({ tenantId: TENANT_A, scopes: [] }, CONTEXT)).rejects.toBeInstanceOf(ResourceNotFoundError);
      registry.items.set(TENANT_A, tenantRecord('DELETING'));
      await expect(service.UpdateTenant({ tenantId: TENANT_A, scopes: [] }, CONTEXT)).rejects.toBeInstanceOf(ConflictError);
    });

    it('GetTenant on a row written before ADR-0035 reports no scopes', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord());
      expect((await makeService(registry, mockProvisioner()).GetTenant({ tenantId: TENANT_A }, CONTEXT)).tenant?.scopes).toEqual([]);
    });
  });

  describe('user scopes (ADR-0036)', () => {
    function entitled(...scopes: string[]): FakeRegistry {
      const registry = new FakeRegistry().withScopes('a/b', 'c/d', 'e/f');
      registry.items.set(TENANT_A, { ...tenantRecord(), scopes });
      return registry;
    }

    it('GetUser and ListUsers report the effective scopes: catalogue ∩ entitlement ∩ grant', async () => {
      const registry = entitled('a/b', 'c/d', 'gone/x');
      const provisioner = mockProvisioner();
      provisioner.getUser.mockResolvedValue({ ...userView('u1'), grantedScopes: ['c/d', 'e/f'] });
      provisioner.listUsers.mockResolvedValue({ items: [userView('all'), { ...userView('none'), grantedScopes: [] }] });
      const service = makeService(registry, provisioner);
      expect((await service.GetUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT)).user?.scopes).toEqual(['c/d']);
      const listed = (await service.ListUsers({ tenantId: TENANT_A }, CONTEXT)).users!;
      expect(listed[0].scopes).toEqual(['a/b', 'c/d']);
      expect(listed[1].scopes).toEqual([]);
    });

    it('UpdateUser with scopes validates against the entitlement, then writes through the provisioner', async () => {
      const registry = entitled('a/b', 'c/d');
      const provisioner = mockProvisioner();
      provisioner.setScopes.mockResolvedValue({ ...userView('u1'), grantedScopes: ['c/d'] });
      const out = await makeService(registry, provisioner).UpdateUser({ tenantId: TENANT_A, username: 'u1', scopes: ['c/d'] }, CONTEXT);
      expect(provisioner.setScopes).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'u1', ['c/d']);
      expect(provisioner.setAdmin).not.toHaveBeenCalled();
      expect(out.user?.scopes).toEqual(['c/d']);
    });

    it('UpdateUser with admin and scopes does both, admin first', async () => {
      const registry = entitled('a/b');
      const provisioner = mockProvisioner();
      provisioner.setAdmin.mockResolvedValue(userView('u1', true));
      provisioner.setScopes.mockResolvedValue({ ...userView('u1', true), grantedScopes: [] });
      const out = await makeService(registry, provisioner).UpdateUser({ tenantId: TENANT_A, username: 'u1', admin: true, scopes: [] }, CONTEXT);
      expect(provisioner.setAdmin.mock.invocationCallOrder[0]).toBeLessThan(provisioner.setScopes.mock.invocationCallOrder[0]);
      expect(out.user).toMatchObject({ admin: true, scopes: [] });
    });

    it.each([
      ['a scope the tenant does not hold', ['e/f']],
      ['a duplicate', ['a/b', 'a/b']],
      ['the admin scope', ['tenant-admin/users']],
    ])('UpdateUser with %s is 400 invalid_scope and writes neither the flag nor the grant', async (_label, scopes) => {
      const registry = entitled('a/b', 'c/d');
      const provisioner = mockProvisioner();
      await expect(
        makeService(registry, provisioner).UpdateUser({ tenantId: TENANT_A, username: 'u1', admin: true, scopes }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', message: expect.stringMatching(/^invalid_scope/) });
      expect(provisioner.setAdmin).not.toHaveBeenCalled();
      expect(provisioner.setScopes).not.toHaveBeenCalled();
    });

    it('UpdateUser with neither admin nor scopes is 400', async () => {
      const registry = entitled('a/b');
      await expect(
        makeService(registry, mockProvisioner()).UpdateUser({ tenantId: TENANT_A, username: 'u1' }, CONTEXT),
      ).rejects.toMatchObject({ name: 'ValidationError', reason: 'InvalidInput' });
    });

    it('UpdateUser scopes on a DELETING tenant is 409 (P-2)', async () => {
      const registry = new FakeRegistry();
      registry.items.set(TENANT_A, tenantRecord('DELETING'));
      await expect(
        makeService(registry, mockProvisioner()).UpdateUser({ tenantId: TENANT_A, username: 'u1', scopes: [] }, CONTEXT),
      ).rejects.toBeInstanceOf(ConflictError);
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
