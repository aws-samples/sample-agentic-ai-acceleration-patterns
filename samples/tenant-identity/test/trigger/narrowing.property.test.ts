// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import * as fc from 'fast-check';
import {
  adminGroupName,
  ALL_SCOPES,
  API_SCOPES,
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_TENANT_ADMIN,
  tenantGroupName,
} from '../../src/shared/constants';
import type { RegistryReader, TenantRecord, TenantStatus } from '../../src/shared/registry';
import type { ResolvedTenants, TenantSource } from '../../src/topology/provisioner';
import { handlePreTokenGeneration } from '../../src/trigger/pre-token-generation';

/**
 * Property tests (spec §10 unit-assertion paragraph, ADR-0010): narrowing
 * never widens. For arbitrary user tenant sets, arbitrary admin groups, and
 * arbitrary clientMetadata (arbitrary keys and values, plus the two real §8.2
 * keys with random values), the core either throws or produces an output
 * whose tenant(s) are a subset of the user's ACTIVE tenants and whose scopes
 * are a subset of what the user holds for that tenant; a narrowed output
 * equals the request exactly.
 */

const NUM_RUNS = 500;

// A pool of distinct valid ULIDs to draw tenant ids from.
const ULID_POOL = [
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  '01C0ABCDEFGHJKMNPQRSTVWXYZ',
  '01D1234567890ABCDEFGHJKMNP',
  '01E9Z8Y7X6W5V4T3S2R1Q0P9NM',
];

const unusedRegistry: RegistryReader = {
  get: async () => undefined,
  batchGet: async () => [],
  getByUserPoolId: async () => undefined,
};

function record(tenantId: string, status: TenantStatus): TenantRecord {
  return {
    tenantId,
    name: 'n',
    status,
    topology: 'shared-pool-multi-tenant',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

interface TenantSpec {
  readonly id: string;
  readonly status: TenantStatus;
  readonly admin: boolean;
}

/** Distinct tenants with random statuses and admin flags. */
const tenantSpecs = fc
  .uniqueArray(fc.constantFrom(...ULID_POOL), { minLength: 1, maxLength: ULID_POOL.length })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          status: fc.constantFrom<TenantStatus>('ACTIVE', 'DELETING'),
          admin: fc.boolean(),
        }),
      ),
    ),
  ) as fc.Arbitrary<TenantSpec[]>;

/** Arbitrary clientMetadata: random keys/values, plus the two real keys. */
const clientMetadataArb = fc
  .tuple(
    fc.dictionary(fc.string(), fc.string(), { maxKeys: 4 }),
    fc.option(
      fc.oneof(
        fc.constantFrom(...ULID_POOL),
        fc.string(), // sometimes a malformed tenant key
      ),
      { nil: undefined },
    ),
    fc.option(
      fc.oneof(
        // sometimes a subset of real scopes, sometimes junk, sometimes empty
        fc.subarray([...ALL_SCOPES]).map((xs) => xs.join(' ')),
        fc.string(),
      ),
      { nil: undefined },
    ),
  )
  .map(([extra, tenantKey, scopeKey]) => {
    const md: Record<string, string> = { ...extra };
    // Remove any accidental real keys from the random dictionary so only the
    // intentional values below decide narrowing.
    delete md[NARROW_TENANT_KEY];
    delete md[NARROW_SCOPE_KEY];
    if (tenantKey !== undefined) {
      md[NARROW_TENANT_KEY] = tenantKey;
    }
    if (scopeKey !== undefined) {
      md[NARROW_SCOPE_KEY] = scopeKey;
    }
    return md;
  });

function buildEvent(specs: TenantSpec[], md: Record<string, string>): PreTokenGenerationV2TriggerEvent {
  const groups: string[] = [];
  for (const s of specs) {
    groups.push(tenantGroupName(s.id));
    if (s.admin) {
      groups.push(adminGroupName(s.id));
    }
  }
  return {
    version: '2',
    region: 'us-east-1',
    userPoolId: 'us-east-1_pool',
    triggerSource: 'TokenGeneration_Authentication',
    userName: 'user-1',
    callerContext: { awsSdkVersion: '3', clientId: 'client-1' },
    request: {
      userAttributes: { sub: 'sub-1' },
      groupConfiguration: { groupsToOverride: groups },
      clientMetadata: md,
    },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

function multiSource(specs: TenantSpec[]): TenantSource {
  const resolved: ResolvedTenants = {
    kind: 'multi',
    records: specs.map((s) => record(s.id, s.status)),
  };
  return { topology: 'shared-pool-multi-tenant', resolve: async () => resolved };
}

describe('ADR-0010: narrowing never widens (property)', () => {
  it('output tenants/scopes are a subset of what the user holds, or it throws', async () => {
    await fc.assert(
      fc.asyncProperty(tenantSpecs, clientMetadataArb, async (specs, md) => {
        const activeIds = new Set(specs.filter((s) => s.status === 'ACTIVE').map((s) => s.id));
        const adminActiveIds = new Set(
          specs.filter((s) => s.status === 'ACTIVE' && s.admin).map((s) => s.id),
        );
        const source = multiSource(specs);
        const event = buildEvent(specs, md);
        const isNarrowing = md[NARROW_TENANT_KEY] !== undefined || md[NARROW_SCOPE_KEY] !== undefined;

        let result: PreTokenGenerationV2TriggerEvent;
        try {
          result = await handlePreTokenGeneration(event, { source, registry: unusedRegistry });
        } catch (error) {
          // A refusal is always acceptable. If it refused, prefixes must be the
          // fixed ones (never leaking input).
          const message = (error as Error).message;
          expect(/^invalid_(target|scope): /.test(message)).toBe(true);
          return;
        }

        const gen = result.response.claimsAndScopeOverrideDetails.accessTokenGeneration;
        expect(gen).toBeDefined();
        const scopes = gen!.scopesToAdd ?? [];

        if (isNarrowing) {
          // Narrowed: exactly one tenant, which must be ACTIVE and held.
          const claims = gen!.claimsToAddOrOverride ?? {};
          expect(claims).toHaveProperty('tenant_id');
          expect(claims).not.toHaveProperty('tenants');
          const tenantId = claims.tenant_id;
          expect(activeIds.has(tenantId)).toBe(true);

          // Output scopes equal the requested set exactly (ADR-0010).
          const requested = (md[NARROW_SCOPE_KEY] ?? '').split(' ').filter((x) => x.length > 0);
          expect([...scopes].sort()).toEqual([...requested].sort());

          // Every output scope is one the user holds for that tenant.
          for (const scope of scopes) {
            if (scope === SCOPE_TENANT_ADMIN) {
              expect(adminActiveIds.has(tenantId)).toBe(true);
            } else {
              expect(API_SCOPES).toContain(scope);
            }
          }
          // A narrowed token suppresses Cognito's own admin scope.
          expect(gen!.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
        } else {
          // Un-narrowed multi: tenants are a subset of the ACTIVE set; scopes
          // are exactly the API scopes and never tenant-admin/users.
          const claims = gen!.claimsToAddOrOverride ?? {};
          const tenants = claims.tenants as unknown as string[];
          for (const t of tenants) {
            expect(activeIds.has(t)).toBe(true);
          }
          expect([...scopes].sort()).toEqual([...API_SCOPES].sort());
          expect(scopes).not.toContain(SCOPE_TENANT_ADMIN);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
