// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import * as fc from 'fast-check';
import {
  adminGroupName,
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_TENANT_ADMIN,
  tenantGroupName,
} from '../../src/shared/constants';
import type { RegistryReader, TenantRecord, TenantStatus } from '../../src/shared/registry';
import { StaticScopeCatalogue } from '../../src/shared/scope-catalogue';
import type { ResolvedTenants, TenantSource } from '../../src/topology/provisioner';
import { handlePreTokenGeneration } from '../../src/trigger/pre-token-generation';

/**
 * Property tests (spec §10 unit-assertion paragraph, ADR-0010, ADR-0035,
 * ADR-0036): narrowing never widens. For arbitrary user tenant sets,
 * arbitrary admin groups, an arbitrary catalogue, arbitrary per-tenant
 * entitlements and per-tenant grants, and arbitrary clientMetadata
 * (arbitrary keys and values, plus the two real §8.2 keys with random
 * values), the core either throws or produces an output whose tenant(s) are
 * a subset of the user's ACTIVE tenants and whose scopes are a subset of
 * `held` for that tenant; a narrowed output equals the request exactly, and
 * an un-narrowed multi-tenant output is the intersection of `held` over the
 * active tenants.
 */

/** Every scope name that can appear anywhere: catalogue, entitlement, grant, request. */
const SCOPE_UNIVERSE = ['sample/read', 'sample/write', 'billing/read', 'billing/invoke', 'default/chat'];

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
  listScopeNames: async () => [],
};

function record(tenantId: string, status: TenantStatus, scopes: readonly string[]): TenantRecord {
  return {
    tenantId,
    name: 'n',
    status,
    topology: 'shared-pool-multi-tenant',
    scopes,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

interface TenantSpec {
  readonly id: string;
  readonly status: TenantStatus;
  readonly admin: boolean;
  /** The tenant's entitlement (ADR-0035): any subset of the universe. */
  readonly entitled: readonly string[];
  /** The user's grant for the tenant (ADR-0036): absent, or any subset of the universe. */
  readonly granted: readonly string[] | undefined;
}

/** Distinct tenants with random statuses, admin flags, entitlements and grants. */
const tenantSpecs = fc
  .uniqueArray(fc.constantFrom(...ULID_POOL), { minLength: 1, maxLength: ULID_POOL.length })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          status: fc.constantFrom<TenantStatus>('ACTIVE', 'DELETING'),
          admin: fc.boolean(),
          entitled: fc.subarray(SCOPE_UNIVERSE),
          granted: fc.option(fc.subarray(SCOPE_UNIVERSE), { nil: undefined }),
        }),
      ),
    ),
  ) as fc.Arbitrary<TenantSpec[]>;

/** The catalogue (ADR-0034): any subset of the universe, including empty. */
const catalogueArb = fc.subarray(SCOPE_UNIVERSE);

/** `held(user, tenant)` minus the admin scope, as spec §8.1 defines it. */
function heldFor(spec: TenantSpec, catalogue: readonly string[]): Set<string> {
  return new Set(
    spec.entitled.filter((s) => catalogue.includes(s) && (spec.granted === undefined || spec.granted.includes(s))),
  );
}

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
        fc.subarray([...SCOPE_UNIVERSE, SCOPE_TENANT_ADMIN]).map((xs) => xs.join(' ')),
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
  const byId = new Map(specs.map((s) => [s.id, s]));
  const resolved: ResolvedTenants = {
    kind: 'multi',
    records: specs.map((s) => record(s.id, s.status, s.entitled)),
    grantedScopes: (tenantId) => byId.get(tenantId)?.granted,
  };
  return { topology: 'shared-pool-multi-tenant', resolve: async () => resolved };
}

describe('ADR-0010: narrowing never widens (property)', () => {
  it('output tenants/scopes are a subset of what the user holds, or it throws', async () => {
    await fc.assert(
      fc.asyncProperty(tenantSpecs, catalogueArb, clientMetadataArb, async (specs, catalogueNames, md) => {
        const activeIds = new Set(specs.filter((s) => s.status === 'ACTIVE').map((s) => s.id));
        const adminActiveIds = new Set(
          specs.filter((s) => s.status === 'ACTIVE' && s.admin).map((s) => s.id),
        );
        const byId = new Map(specs.map((s) => [s.id, s]));
        const source = multiSource(specs);
        const catalogue = new StaticScopeCatalogue(catalogueNames);
        const event = buildEvent(specs, md);
        const isNarrowing = md[NARROW_TENANT_KEY] !== undefined || md[NARROW_SCOPE_KEY] !== undefined;

        let result: PreTokenGenerationV2TriggerEvent;
        try {
          result = await handlePreTokenGeneration(event, { source, registry: unusedRegistry, catalogue });
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

          // Every output scope is one the user holds for that tenant
          // (ADR-0035): in the catalogue, in the entitlement, in the grant.
          const held = heldFor(byId.get(tenantId)!, catalogueNames);
          for (const scope of scopes) {
            if (scope === SCOPE_TENANT_ADMIN) {
              expect(adminActiveIds.has(tenantId)).toBe(true);
            } else {
              expect(held.has(scope)).toBe(true);
            }
          }
          // A narrowed token suppresses Cognito's own admin scope.
          expect(gen!.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
        } else {
          // Un-narrowed multi: tenants are a subset of the ACTIVE set; scopes
          // are exactly the intersection of `held` over the active tenants
          // (ADR-0035) and never tenant-admin/users.
          const claims = gen!.claimsToAddOrOverride ?? {};
          const tenants = claims.tenants as unknown as string[];
          for (const t of tenants) {
            expect(activeIds.has(t)).toBe(true);
          }
          const active = specs.filter((s) => s.status === 'ACTIVE');
          const expected = SCOPE_UNIVERSE.filter((s) => active.every((spec) => heldFor(spec, catalogueNames).has(s)));
          expect([...scopes].sort()).toEqual(expected.sort());
          expect(scopes).not.toContain(SCOPE_TENANT_ADMIN);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
