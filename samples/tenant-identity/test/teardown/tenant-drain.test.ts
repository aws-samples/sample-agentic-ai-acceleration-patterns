// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for the pure drain (ADR-0022). The registry and provisioner are
 * mocked: the drain pages the registry, replays the DeleteTenant sequence per
 * tenant (markDeleting -> deprovisionTenant -> delete, R-11), skips a tenant
 * that is already gone (NotFoundError, idempotent), and surfaces the first
 * deprovision failure so the custom resource can answer FAILED.
 */

import { NotFoundError } from '../../src/shared/errors';
import type { Page, Registry, TenantRecord } from '../../src/shared/registry';
import { drainTenants } from '../../src/teardown/tenant-drain';
import type { Provisioner } from '../../src/topology';

function tenant(tenantId: string): TenantRecord {
  return {
    tenantId,
    name: `name-${tenantId}`,
    status: 'ACTIVE',
    topology: 'pool-per-tenant',
    userPoolId: `eu-central-1_${tenantId}`,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

function registryMock(pages: Array<Page<TenantRecord>>): jest.Mocked<Registry> {
  const list = jest.fn();
  for (const page of pages) {
    list.mockResolvedValueOnce(page);
  }
  return {
    list,
    get: jest.fn(),
    batchGet: jest.fn(),
    getByUserPoolId: jest.fn(),
    create: jest.fn(),
    // markDeleting echoes the record back as DELETING by default.
    markDeleting: jest.fn(async (tenantId: string) => ({ ...tenant(tenantId), status: 'DELETING' as const })),
    delete: jest.fn(),
  } as unknown as jest.Mocked<Registry>;
}

function provisionerMock(): jest.Mocked<Provisioner> {
  return {
    topology: 'pool-per-tenant',
    provisionTenant: jest.fn(),
    deprovisionTenant: jest.fn().mockResolvedValue(undefined),
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

describe('drainTenants (ADR-0022)', () => {
  it('drains two pages and counts the deletes', async () => {
    const registry = registryMock([
      { items: [tenant('A'), tenant('B')], nextToken: 'page2' },
      { items: [tenant('C')], nextToken: undefined },
    ]);
    const provisioner = provisionerMock();

    const result = await drainTenants({ registry, provisioner });

    expect(result).toEqual({ deleted: 3 });
    // Two pages were read, the second with the first page's nextToken.
    expect(registry.list).toHaveBeenNthCalledWith(1, undefined);
    expect(registry.list).toHaveBeenNthCalledWith(2, 'page2');
    // Every tenant ran the full R-11 sequence.
    expect(registry.markDeleting.mock.calls.map((c) => c[0])).toEqual(['A', 'B', 'C']);
    expect(provisioner.deprovisionTenant).toHaveBeenCalledTimes(3);
    expect(registry.delete.mock.calls.map((c) => c[0])).toEqual(['A', 'B', 'C']);
  });

  it('passes the DELETING record (not the ACTIVE one) to deprovisionTenant (R-11)', async () => {
    const registry = registryMock([{ items: [tenant('A')], nextToken: undefined }]);
    const provisioner = provisionerMock();

    await drainTenants({ registry, provisioner });

    expect(provisioner.deprovisionTenant).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'A', status: 'DELETING' }),
    );
  });

  it('skips a tenant already gone (NotFoundError on markDeleting) and keeps going', async () => {
    const registry = registryMock([{ items: [tenant('A'), tenant('B')], nextToken: undefined }]);
    const provisioner = provisionerMock();
    registry.markDeleting
      .mockRejectedValueOnce(new NotFoundError('Tenant A not found'))
      .mockResolvedValueOnce({ ...tenant('B'), status: 'DELETING' });

    const result = await drainTenants({ registry, provisioner });

    expect(result).toEqual({ deleted: 1 });
    // A was skipped: no deprovision, no delete for it.
    expect(provisioner.deprovisionTenant).toHaveBeenCalledTimes(1);
    expect(provisioner.deprovisionTenant).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'B' }));
    expect(registry.delete).toHaveBeenCalledTimes(1);
    expect(registry.delete).toHaveBeenCalledWith('B');
  });

  it('propagates a deprovision error (so the custom resource answers FAILED)', async () => {
    const registry = registryMock([{ items: [tenant('A')], nextToken: undefined }]);
    const provisioner = provisionerMock();
    provisioner.deprovisionTenant.mockRejectedValueOnce(new Error('cognito boom'));

    await expect(drainTenants({ registry, provisioner })).rejects.toThrow('cognito boom');
    // The registry item is left for a retried drain to pick up.
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it('re-throws a non-NotFound markDeleting error', async () => {
    const registry = registryMock([{ items: [tenant('A')], nextToken: undefined }]);
    const provisioner = provisionerMock();
    registry.markDeleting.mockReset().mockRejectedValueOnce(new Error('ddb throttled'));

    await expect(drainTenants({ registry, provisioner })).rejects.toThrow('ddb throttled');
    expect(provisioner.deprovisionTenant).not.toHaveBeenCalled();
  });
});
