// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { IDS, tenant } from './helpers';
import { InvalidInputError } from '../../src/shared/errors';
import type { RegistryReader, TenantRecord } from '../../src/shared/registry';
import { tenantSourceFor } from '../../src/topology/tenant-source';

/** A registry reader stub backed by in-memory records. */
function reader(over: Partial<RegistryReader> = {}): RegistryReader {
  return {
    get: jest.fn(async () => undefined),
    batchGet: jest.fn(async () => []),
    getByUserPoolId: jest.fn(async () => undefined),
    ...over,
  };
}

function event(partial: {
  userPoolId?: string;
  attributes?: Record<string, string>;
  groups?: string[];
}): PreTokenGenerationV2TriggerEvent {
  return {
    userPoolId: partial.userPoolId ?? 'eu-central-1_pool',
    request: {
      userAttributes: partial.attributes ?? {},
      groupConfiguration: { groupsToOverride: partial.groups ?? [], iamRolesToOverride: [], preferredRole: undefined },
    },
  } as unknown as PreTokenGenerationV2TriggerEvent;
}

describe('tenantSourceFor (spec §8 tenant lookup, §4.2)', () => {
  describe('pool-per-tenant', () => {
    const source = tenantSourceFor('pool-per-tenant');

    it('resolves the tenant that owns the pool (§4.2)', async () => {
      const record = tenant({ tenantId: IDS.a, topology: 'pool-per-tenant', userPoolId: 'eu-central-1_p1' });
      const reg = reader({ getByUserPoolId: jest.fn(async () => record) });
      const result = await source.resolve(event({ userPoolId: 'eu-central-1_p1' }), reg);
      expect(result).toEqual({ kind: 'single', tenantId: IDS.a, record });
    });

    it('throws on an unknown pool (§4.2)', async () => {
      const reg = reader({ getByUserPoolId: jest.fn(async () => undefined) });
      await expect(source.resolve(event({ userPoolId: 'eu-central-1_ghost' }), reg)).rejects.toThrow(/^invalid_target: unknown user pool$/);
    });
  });

  describe('shared-pool', () => {
    const source = tenantSourceFor('shared-pool');

    it('resolves the tenant from custom:tenantId', async () => {
      const record = tenant({ tenantId: IDS.a });
      const get = jest.fn(async () => record);
      const reg = reader({ get });
      const result = await source.resolve(event({ attributes: { 'custom:tenantId': IDS.a } }), reg);
      expect(result).toEqual({ kind: 'single', tenantId: IDS.a, record });
      expect(get).toHaveBeenCalledWith(IDS.a);
    });

    it('returns an undefined record when the registry has no such tenant', async () => {
      const result = await source.resolve(event({ attributes: { 'custom:tenantId': IDS.a } }), reader());
      expect(result).toEqual({ kind: 'single', tenantId: IDS.a, record: undefined });
    });

    it('throws when the attribute is not a ULID (P-3)', async () => {
      await expect(source.resolve(event({ attributes: { 'custom:tenantId': 'not-a-ulid' } }), reader())).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('throws when the attribute is absent', async () => {
      await expect(source.resolve(event({ attributes: {} }), reader())).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('refuses with the invalid_target prefix, so the exchange returns invalid_target (§5.4)', async () => {
      await expect(source.resolve(event({ attributes: {} }), reader())).rejects.toThrow(/^invalid_target: /);
    });
  });

  describe('shared-pool-multi-tenant', () => {
    const source = tenantSourceFor('shared-pool-multi-tenant');

    it('maps t- groups to tenants via batchGet, ignoring other groups (§7.3, §11)', async () => {
      const records: TenantRecord[] = [tenant({ tenantId: IDS.a }), tenant({ tenantId: IDS.b })];
      const batchGet = jest.fn(async () => records);
      const reg = reader({ batchGet });
      const result = await source.resolve(
        event({ groups: [`t-${IDS.a}`, `t-${IDS.b}`, `admin-${IDS.a}`, 'role-admin'] }),
        reg,
      );
      expect(result).toEqual({ kind: 'multi', records });
      expect(batchGet).toHaveBeenCalledWith([IDS.a, IDS.b]);
    });

    it('returns an empty multi result when no t- group is present', async () => {
      const batchGet = jest.fn(async () => []);
      const reg = reader({ batchGet });
      const result = await source.resolve(event({ groups: ['role-admin'] }), reg);
      expect(result).toEqual({ kind: 'multi', records: [] });
      expect(batchGet).toHaveBeenCalledWith([]);
    });
  });
});
