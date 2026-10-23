// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for the pure drain (ADR-0022). The registry and provisioner are
 * mocked: the drain pages the registry, replays the DeleteTenant sequence per
 * tenant (markDeleting -> deprovisionTenant -> delete, R-11), skips a tenant
 * that is already gone (NotFoundError, idempotent), and surfaces the first
 * deprovision failure so the custom resource can answer FAILED. ADR-0027: it
 * picks each tenant's provisioner by the row's topology.
 */

import type { Topology } from '../../src/shared/constants';
import { NotFoundError } from '../../src/shared/errors';
import type { Page, Registry, TenantRecord } from '../../src/shared/registry';
import type { TenantApiKeys } from '../../src/shared/tenant-api-keys';
import { drainTenants } from '../../src/teardown/tenant-drain';
import type { Provisioner, ProvisionersFor } from '../../src/topology';

function tenant(tenantId: string, topology: Topology = 'pool-per-tenant'): TenantRecord {
  return {
    tenantId,
    name: `name-${tenantId}`,
    status: 'ACTIVE',
    topology,
    userPoolId: `eu-central-1_${tenantId}`,
    apiKeyId: `key-${tenantId}`,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

function registryMock(pages: Array<Page<TenantRecord>>): jest.Mocked<Registry> {
  const list = jest.fn();
  for (const page of pages) {
    list.mockResolvedValueOnce(page);
  }
  // Every row the pages hold, so markDeleting can echo the right topology.
  const rows = new Map(pages.flatMap((p) => p.items).map((r) => [r.tenantId, r]));
  return {
    list,
    get: jest.fn(),
    batchGet: jest.fn(),
    getByUserPoolId: jest.fn(),
    create: jest.fn(),
    // markDeleting echoes the record back as DELETING by default.
    markDeleting: jest.fn(async (tenantId: string) => ({
      ...(rows.get(tenantId) ?? tenant(tenantId)),
      status: 'DELETING' as const,
    })),
    delete: jest.fn(),
  } as unknown as jest.Mocked<Registry>;
}

function provisionerMock(topology: Topology = 'pool-per-tenant'): jest.Mocked<Provisioner> {
  return {
    topology,
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

/** One mock for every topology (a single-topology stack). */
function provisionersFor(provisioner: jest.Mocked<Provisioner>): ProvisionersFor {
  return () => provisioner;
}

let apiKeys: jest.Mocked<TenantApiKeys>;
beforeEach(() => {
  apiKeys = { create: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) };
});

describe('drainTenants (ADR-0022)', () => {
  it('drains two pages and counts the deletes', async () => {
    const registry = registryMock([
      { items: [tenant('A'), tenant('B')], nextToken: 'page2' },
      { items: [tenant('C')], nextToken: undefined },
    ]);
    const provisioner = provisionerMock();

    const result = await drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys });

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

    await drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys });

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

    const result = await drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys });

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

    await expect(drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys })).rejects.toThrow('cognito boom');
    // The registry item is left for a retried drain to pick up.
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it('re-throws a non-NotFound markDeleting error', async () => {
    const registry = registryMock([{ items: [tenant('A')], nextToken: undefined }]);
    const provisioner = provisionerMock();
    registry.markDeleting.mockReset().mockRejectedValueOnce(new Error('ddb throttled'));

    await expect(drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys })).rejects.toThrow('ddb throttled');
    expect(provisioner.deprovisionTenant).not.toHaveBeenCalled();
  });

  it('deletes each tenant\'s API key after Cognito and before the registry row (ADR-0025)', async () => {
    const registry = registryMock([{ items: [tenant('A'), tenant('B')], nextToken: undefined }]);
    const provisioner = provisionerMock();

    await drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys });

    expect(apiKeys.delete.mock.calls.map((c) => c[0])).toEqual(['key-A', 'key-B']);
    expect(provisioner.deprovisionTenant.mock.invocationCallOrder[0]).toBeLessThan(apiKeys.delete.mock.invocationCallOrder[0]);
    expect(apiKeys.delete.mock.invocationCallOrder[0]).toBeLessThan(registry.delete.mock.invocationCallOrder[0]);
    expect(apiKeys.create).not.toHaveBeenCalled();
  });

  it('a key delete failure leaves the row for a retried drain (ADR-0025, ADR-0022)', async () => {
    const registry = registryMock([{ items: [tenant('A')], nextToken: undefined }]);
    const provisioner = provisionerMock();
    apiKeys.delete.mockRejectedValueOnce(new Error('TooManyRequestsException'));

    await expect(drainTenants({ registry, provisioners: provisionersFor(provisioner), apiKeys })).rejects.toThrow('TooManyRequestsException');
    expect(registry.delete).not.toHaveBeenCalled();
  });

  describe('tiered deployment (ADR-0027)', () => {
    it('deprovisions each row through the provisioner of its own topology', async () => {
      const registry = registryMock([
        { items: [tenant('S1', 'shared-pool'), tenant('P1', 'pool-per-tenant'), tenant('S2', 'shared-pool')], nextToken: undefined },
      ]);
      const shared = provisionerMock('shared-pool');
      const perTenant = provisionerMock('pool-per-tenant');
      const asked: Topology[] = [];
      const provisioners: ProvisionersFor = (topology) => {
        asked.push(topology);
        return topology === 'shared-pool' ? shared : perTenant;
      };

      const result = await drainTenants({ registry, provisioners, apiKeys });

      expect(result).toEqual({ deleted: 3 });
      expect(asked).toEqual(['shared-pool', 'pool-per-tenant', 'shared-pool']);
      expect(shared.deprovisionTenant.mock.calls.map((c) => c[0].tenantId)).toEqual(['S1', 'S2']);
      expect(perTenant.deprovisionTenant.mock.calls.map((c) => c[0].tenantId)).toEqual(['P1']);
      // Each got the DELETING row, with its topology intact.
      expect(perTenant.deprovisionTenant).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'P1', status: 'DELETING', topology: 'pool-per-tenant' }),
      );
    });

    it('a row with a topology the deployment does not offer fails the drain, leaving the row (no fallback)', async () => {
      const registry = registryMock([{ items: [tenant('X', 'shared-pool-multi-tenant')], nextToken: undefined }]);
      const provisioners: ProvisionersFor = (topology) => {
        throw new Error(`Topology ${topology} is not offered by deployment tiered`);
      };

      await expect(drainTenants({ registry, provisioners, apiKeys })).rejects.toThrow('not offered');
      expect(apiKeys.delete).not.toHaveBeenCalled();
      expect(registry.delete).not.toHaveBeenCalled();
    });
  });
});
