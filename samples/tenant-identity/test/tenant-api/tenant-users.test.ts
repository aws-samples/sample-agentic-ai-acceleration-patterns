// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConflictError, InvalidInputError, NotFoundError, UnsupportedInTopologyError } from '../../src/shared/errors';
import type { RegistryReader, TenantRecord } from '../../src/shared/registry';
import {
  ConflictError as ModeledConflictError,
  InternalServerError,
  ResourceNotFoundError,
  ValidationError,
} from '../../src/smithy/tenant/typescript-ssdk-codegen/src/models/errors';
import { TenantUsersService, type TenantCallerContext } from '../../src/tenant-api/tenant-users';
import type { Provisioner, UserView } from '../../src/topology/provisioner';

/**
 * Unit tests for the tenant admin service (spec §5.2, P-11, R-12, R-13,
 * ADR-0014). The tenant comes only from the authoriser context; a stray
 * tenant field on the input is ignored. Error mappings follow §5.3.
 */

const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';
const CALLER_SUB = 'admin-sub-0001';
const context: TenantCallerContext = { tenantId: TENANT_A, sub: CALLER_SUB };

function activeTenant(over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: TENANT_A,
    name: 'Tenant A',
    status: 'ACTIVE',
    topology: 'shared-pool',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...over,
  };
}

function userView(over: Partial<UserView> = {}): UserView {
  return {
    username: 'target-sub-9999',
    email: 'target@example.com',
    admin: false,
    status: 'CONFIRMED',
    createdAt: new Date('2026-10-21T00:00:00.000Z'),
    ...over,
  };
}

function fakeRegistry(...args: [TenantRecord | undefined] | []): RegistryReader {
  const tenant = args.length === 0 ? activeTenant() : args[0];
  return {
    get: jest.fn().mockResolvedValue(tenant),
    batchGet: jest.fn().mockResolvedValue([]),
    getByUserPoolId: jest.fn().mockResolvedValue(undefined),
  };
}

function mockProvisioner(over: Partial<Provisioner> = {}): jest.Mocked<Provisioner> {
  return {
    topology: 'shared-pool',
    provisionTenant: jest.fn(),
    deprovisionTenant: jest.fn(),
    createUser: jest.fn().mockResolvedValue({ user: userView(), temporaryPassword: 'Temp#12345' }),
    assertMember: jest.fn().mockResolvedValue(undefined),
    // R-16 (T-26): getUser now answers two callers — requireCallerAdmin asks
    // for the caller's own sub (must be an admin), resolveTarget asks for the
    // path username (the target). Default: the caller is an admin, everyone
    // else is the non-admin target view.
    getUser: jest.fn().mockImplementation((_tenant: TenantRecord, username: string) =>
      Promise.resolve(username === CALLER_SUB ? userView({ username: CALLER_SUB, admin: true }) : userView()),
    ),
    listUsers: jest.fn().mockResolvedValue({ items: [userView()], nextToken: undefined }),
    setAdmin: jest.fn().mockResolvedValue(userView({ admin: true })),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    createMembership: jest.fn(),
    deleteMembership: jest.fn(),
    issueToken: jest.fn(),
    refreshToken: jest.fn(),
    ...over,
  } as unknown as jest.Mocked<Provisioner>;
}

describe('TenantUsersService — tenant from context only (P-11)', () => {
  it('ignores a stray tenantId on the input and uses context.tenantId', async () => {
    const registry = fakeRegistry();
    const provisioner = mockProvisioner();
    const service = new TenantUsersService(registry, provisioner);

    // Cast to sneak a tenant field into the input; it must be ignored.
    const input = { email: 'new@example.com', admin: false, tenantId: 'EVIL_TENANT' } as unknown as {
      email?: string;
      admin?: boolean;
    };
    await service.CreateTenantUser(input, context);

    expect(registry.get).toHaveBeenCalledWith(TENANT_A);
    expect(registry.get).not.toHaveBeenCalledWith('EVIL_TENANT');
    // The provisioner receives the context's tenant record, never the input's.
    expect(provisioner.createUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'new@example.com', false);
  });
});

describe('TenantUsersService — every operation', () => {
  it('CreateTenantUser returns the user and temporary password', async () => {
    const service = new TenantUsersService(fakeRegistry(), mockProvisioner());
    const out = await service.CreateTenantUser({ email: 'new@example.com', admin: true }, context);
    expect(out.user?.email).toBe('target@example.com');
    expect(out.temporaryPassword).toBe('Temp#12345');
  });

  it('GetTenantUser runs the membership check via getUser (R-12)', async () => {
    const provisioner = mockProvisioner();
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    const out = await service.GetTenantUser({ username: 'target-sub-9999' }, context);
    expect(provisioner.getUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'target-sub-9999');
    expect(out.user?.username).toBe('target-sub-9999');
  });

  it('ListTenantUsers maps the page', async () => {
    const service = new TenantUsersService(fakeRegistry(), mockProvisioner());
    const out = await service.ListTenantUsers({}, context);
    expect(out.users).toHaveLength(1);
    expect(out.users?.[0].username).toBe('target-sub-9999');
  });

  it('UpdateTenantUser sets the admin flag for another user', async () => {
    const provisioner = mockProvisioner();
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    const out = await service.UpdateTenantUser({ username: 'target-sub-9999', admin: true }, context);
    expect(provisioner.setAdmin).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'target-sub-9999', true);
    expect(out.user?.admin).toBe(true);
  });

  it('DeleteTenantUser deletes another user', async () => {
    const provisioner = mockProvisioner();
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await service.DeleteTenantUser({ username: 'target-sub-9999' }, context);
    expect(provisioner.deleteUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'target-sub-9999');
  });
});

describe('TenantUsersService — R-12 membership (ADR-0013)', () => {
  it('propagates a provisioner NotFoundError as ResourceNotFoundError (404)', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockRejectedValue(new NotFoundError('not in tenant')),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.GetTenantUser({ username: 'elsewhere' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('TenantUsersService — R-13 self-mutation (spec §5.2)', () => {
  it('refuses self-demotion with 409 and never calls setAdmin', async () => {
    // getUser resolves both the caller check and the path username to the
    // caller's own (admin) record; the self-update guard then fires.
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(
      service.UpdateTenantUser({ username: CALLER_SUB, admin: false }, context),
    ).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.setAdmin).not.toHaveBeenCalled();
  });

  it('refuses self-promotion (admin: true) with 409 — extends R-13 (finding R-16 (T-26))', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(
      service.UpdateTenantUser({ username: CALLER_SUB, admin: true }, context),
    ).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.setAdmin).not.toHaveBeenCalled();
  });

  it('refuses self-deletion with 409 and never calls deleteUser', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.DeleteTenantUser({ username: CALLER_SUB }, context)).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses self-deletion even when the path uses the e-mail, not the username', async () => {
    // The caller passes their e-mail; getUser resolves it to their own sub.
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, email: 'me@example.com', admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.DeleteTenantUser({ username: 'me@example.com' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
    expect(provisioner.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses self-demotion even when the path uses the e-mail, not the username', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, email: 'me@example.com', admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(
      service.UpdateTenantUser({ username: 'me@example.com', admin: false }, context),
    ).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.setAdmin).not.toHaveBeenCalled();
  });
});

describe('TenantUsersService — R-16 (T-26) caller admin re-check (finding R-16 (T-26))', () => {
  it('CreateTenantUser 409s when the caller is no longer an admin (admin:false)', async () => {
    // getUser answers the caller's own sub with admin:false.
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: false })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'new@example.com' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
    expect(provisioner.createUser).not.toHaveBeenCalled();
  });

  it('UpdateTenantUser 409s when the caller is no longer an admin (admin:false)', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: false })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(
      service.UpdateTenantUser({ username: 'target-sub-9999', admin: true }, context),
    ).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.setAdmin).not.toHaveBeenCalled();
  });

  it('DeleteTenantUser 409s when the caller is no longer an admin (admin:false)', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: false })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.DeleteTenantUser({ username: 'target-sub-9999' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
    expect(provisioner.deleteUser).not.toHaveBeenCalled();
  });

  it('CreateTenantUser 409s when the caller is no longer a user of the tenant (getUser 404s)', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockRejectedValue(new NotFoundError('caller not in tenant')),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'new@example.com' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
    expect(provisioner.createUser).not.toHaveBeenCalled();
  });
});

describe('TenantUsersService — tenant status (P-2 defence in depth)', () => {
  it('404s when the context tenant is absent from the registry', async () => {
    const service = new TenantUsersService(fakeRegistry(undefined), mockProvisioner());
    await expect(service.GetTenantUser({ username: 'x' }, context)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('409s a mutation when the tenant is DELETING', async () => {
    const service = new TenantUsersService(fakeRegistry(activeTenant({ status: 'DELETING' })), mockProvisioner());
    await expect(service.CreateTenantUser({ email: 'a@example.com' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
  });

  it.each([
    ['CreateTenantUser', (s: TenantUsersService) => s.CreateTenantUser({ email: 'a@example.com' }, context)],
    ['UpdateTenantUser', (s: TenantUsersService) => s.UpdateTenantUser({ username: 'target-sub-9999', admin: true }, context)],
    ['DeleteTenantUser', (s: TenantUsersService) => s.DeleteTenantUser({ username: 'target-sub-9999' }, context)],
  ])('409s %s when the tenant is PROVISIONING and touches no provisioner (ADR-0021, P-2)', async (_name, call) => {
    const provisioner = mockProvisioner();
    const service = new TenantUsersService(fakeRegistry(activeTenant({ status: 'PROVISIONING' })), provisioner);
    await expect(call(service)).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.getUser).not.toHaveBeenCalled();
    expect(provisioner.createUser).not.toHaveBeenCalled();
    expect(provisioner.setAdmin).not.toHaveBeenCalled();
    expect(provisioner.deleteUser).not.toHaveBeenCalled();
  });

  it('allows a read when the tenant is DELETING (read is not a mutation)', async () => {
    const service = new TenantUsersService(fakeRegistry(activeTenant({ status: 'DELETING' })), mockProvisioner());
    await expect(service.GetTenantUser({ username: 'target-sub-9999' }, context)).resolves.toBeDefined();
  });
});

describe('TenantUsersService — error mapping (§5.3)', () => {
  it('ConflictError → ConflictError (409)', async () => {
    const provisioner = mockProvisioner({ createUser: jest.fn().mockRejectedValue(new ConflictError('exists')) });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'a@example.com' }, context)).rejects.toBeInstanceOf(
      ModeledConflictError,
    );
  });

  it('UnsupportedInTopologyError → ValidationError(UnsupportedInTopology)', async () => {
    const provisioner = mockProvisioner({
      createUser: jest.fn().mockRejectedValue(new UnsupportedInTopologyError('CreateTenantUser', 'shared-pool')),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'a@example.com' }, context)).rejects.toMatchObject({
      name: 'ValidationError',
      reason: 'UnsupportedInTopology',
    });
  });

  it('InvalidInputError → ValidationError(InvalidInput)', async () => {
    const provisioner = mockProvisioner({ createUser: jest.fn().mockRejectedValue(new InvalidInputError('bad')) });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'a@example.com' }, context)).rejects.toMatchObject({
      name: 'ValidationError',
      reason: 'InvalidInput',
    });
  });

  it('an unknown error → InternalServerError with a fixed message (N-7)', async () => {
    const provisioner = mockProvisioner({
      createUser: jest.fn().mockRejectedValue(new Error('cognito said something sensitive')),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.CreateTenantUser({ email: 'a@example.com' }, context)).rejects.toMatchObject({
      name: 'InternalServerError',
      message: 'Internal server error',
    });
  });

  it('re-throws a modeled ValidationError unchanged', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockRejectedValue(new ValidationError({ message: 'm', reason: 'InvalidInput' })),
    });
    const service = new TenantUsersService(fakeRegistry(), provisioner);
    await expect(service.GetTenantUser({ username: 'x' }, context)).rejects.toBeInstanceOf(ValidationError);
  });
});

// Keep InternalServerError referenced for clarity of the mapping under test.
void InternalServerError;

describe('TenantUsersService — per-tenant provisioner (ADR-0026)', () => {
  it('asks the factory for the context tenant\'s provisioner and uses it for every Cognito call', async () => {
    const provisioner = mockProvisioner();
    const factory = jest.fn().mockReturnValue(provisioner);
    const service = new TenantUsersService(fakeRegistry(), factory);

    await service.UpdateTenantUser({ username: 'target-sub-9999', admin: true }, context);

    expect(factory).toHaveBeenCalledWith(TENANT_A, 'shared-pool');
    expect(factory).not.toHaveBeenCalledWith(expect.not.stringMatching(TENANT_A), expect.anything());
    // R-16, R-12 and the write all ran on the tenant's provisioner.
    expect(provisioner.getUser).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), CALLER_SUB);
    expect(provisioner.setAdmin).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), 'target-sub-9999', true);
  });

  it('reads use the factory too (Get, List)', async () => {
    const provisioner = mockProvisioner();
    const factory = jest.fn().mockReturnValue(provisioner);
    const service = new TenantUsersService(fakeRegistry(), factory);

    await service.GetTenantUser({ username: 'target-sub-9999' }, context);
    await service.ListTenantUsers({}, context);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(provisioner.listUsers).toHaveBeenCalled();
  });

  it('a credential failure in the factory is a 500 with no detail', async () => {
    const factory = jest.fn().mockImplementation(() => {
      throw Object.assign(new Error('not authorized to perform sts:AssumeRole'), { name: 'AccessDenied' });
    });
    const service = new TenantUsersService(fakeRegistry(), factory);
    await expect(service.ListTenantUsers({}, context)).rejects.toMatchObject({ message: 'Internal server error' });
  });

  it('resolves the strategy from the row it read, never from the deployment (ADR-0027)', async () => {
    // A tiered deployment: the same service serves a standard and a premium
    // tenant, and the row's topology picks the provisioner for each request.
    const provisioner = mockProvisioner();
    const factory = jest.fn().mockReturnValue(provisioner);
    const registry = fakeRegistry(activeTenant({ topology: 'pool-per-tenant', userPoolId: 'eu-central-1_premium' }));
    const service = new TenantUsersService(registry, factory);

    await service.ListTenantUsers({}, context);

    expect(registry.get).toHaveBeenCalledWith(TENANT_A);
    expect(factory).toHaveBeenCalledWith(TENANT_A, 'pool-per-tenant');
  });

  it('the R-13 self-mutation check still runs on scoped credentials (defence in depth)', async () => {
    const provisioner = mockProvisioner({
      getUser: jest.fn().mockResolvedValue(userView({ username: CALLER_SUB, admin: true })),
    });
    const service = new TenantUsersService(fakeRegistry(), () => provisioner);
    await expect(service.DeleteTenantUser({ username: CALLER_SUB }, context)).rejects.toBeInstanceOf(ModeledConflictError);
    expect(provisioner.deleteUser).not.toHaveBeenCalled();
  });
});
