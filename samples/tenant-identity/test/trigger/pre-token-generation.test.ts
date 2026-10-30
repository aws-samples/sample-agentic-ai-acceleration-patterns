// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import {
  adminGroupName,
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_TENANT_ADMIN,
  tenantGroupName,
} from '../../src/shared/constants';
import type { RegistryReader, TenantRecord, TenantStatus } from '../../src/shared/registry';
import { type ScopeCatalogue, StaticScopeCatalogue } from '../../src/shared/scope-catalogue';
import type { GrantedScopes, ResolvedTenants, TenantSource } from '../../src/topology/provisioner';
import { handlePreTokenGeneration, type PreTokenGenerationDeps } from '../../src/trigger/pre-token-generation';

/**
 * Unit tests for the pre-token-generation core (spec §8, §8.1, §8.2,
 * ADR-0003, ADR-0008, ADR-0010, ADR-0015, ADR-0035, ADR-0036). Fakes stand
 * in for the topology TenantSource, the RegistryReader and the scope
 * catalogue so the core is tested in isolation from any topology
 * implementation (only the shared types are imported).
 */

// The two catalogue scopes these tests register (ADR-0034) and, unless a
// test says otherwise, entitle every tenant to (ADR-0035): the fixture's
// entitlement, nothing more.
const SAMPLE_READ = 'sample/read';
const SAMPLE_WRITE = 'sample/write';
const ENTITLEMENT: readonly string[] = [SAMPLE_READ, SAMPLE_WRITE];
const CATALOGUE: ScopeCatalogue = new StaticScopeCatalogue(ENTITLEMENT);

// Two valid ULIDs (Crockford base32, 26 chars) for the fictional tenants A, B.
const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TENANT_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const NOT_A_ULID = 'not-a-ulid';

function record(tenantId: string, status: TenantStatus = 'ACTIVE', scopes: readonly string[] = ENTITLEMENT): TenantRecord {
  return {
    tenantId,
    name: `tenant ${tenantId}`,
    status,
    topology: 'shared-pool',
    scopes,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

/** A resolution without the grant reader; `fixedSource` adds "no grant" (all of the tenant's scopes). */
type Resolution =
  | { kind: 'single'; tenantId: string; record: TenantRecord | undefined; grantedScopes?: GrantedScopes }
  | { kind: 'multi'; records: readonly TenantRecord[]; grantedScopes?: GrantedScopes };

const NO_GRANT: GrantedScopes = () => undefined;

/** A TenantSource that returns a fixed resolution, ignoring the event. */
function fixedSource(resolution: Resolution): TenantSource {
  const resolved = { grantedScopes: NO_GRANT, ...resolution } as ResolvedTenants;
  return {
    topology: resolved.kind === 'single' ? 'shared-pool' : 'shared-pool-multi-tenant',
    resolve: async () => resolved,
  };
}

/** The deps every test passes: the faked source, the unused registry and the two-scope catalogue. */
function deps(source: TenantSource, catalogue: ScopeCatalogue = CATALOGUE): PreTokenGenerationDeps {
  return { source, registry: unusedRegistry, catalogue };
}

/** A TenantSource whose resolve rejects (an unknown pool, a registry outage). */
function throwingSource(error: Error): TenantSource {
  return {
    topology: 'pool-per-tenant',
    resolve: async () => {
      throw error;
    },
  };
}

/** A registry the core never actually calls in these tests (source is faked). */
const unusedRegistry: RegistryReader = {
  get: async () => {
    throw new Error('registry.get should not be called');
  },
  batchGet: async () => {
    throw new Error('registry.batchGet should not be called');
  },
  getByUserPoolId: async () => {
    throw new Error('registry.getByUserPoolId should not be called');
  },
  listScopeNames: async () => {
    throw new Error('registry.listScopeNames should not be called (the catalogue is faked)');
  },
};

interface EventOptions {
  readonly groups?: string[];
  readonly clientMetadata?: Record<string, string>;
  readonly triggerSource?: string;
  readonly sub?: string;
  readonly userName?: string;
  /** Scopes already on the incoming token (V2 `request.scopes`). */
  readonly scopes?: string[];
}

function event(opts: EventOptions = {}): PreTokenGenerationV2TriggerEvent {
  return {
    version: '2',
    region: 'us-east-1',
    userPoolId: 'us-east-1_pool',
    triggerSource: (opts.triggerSource ?? 'TokenGeneration_Authentication') as never,
    userName: opts.userName ?? 'user-1',
    callerContext: { awsSdkVersion: '3', clientId: 'client-1' },
    request: {
      userAttributes: { sub: opts.sub ?? 'sub-1' },
      groupConfiguration: { groupsToOverride: opts.groups ?? [] },
      ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      ...(opts.clientMetadata !== undefined ? { clientMetadata: opts.clientMetadata } : {}),
    },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

function accessGen(result: PreTokenGenerationV2TriggerEvent) {
  return result.response.claimsAndScopeOverrideDetails.accessTokenGeneration;
}

// ---------------------------------------------------------------------------
// §8 output shape, un-narrowed (the §8 table rows)
// ---------------------------------------------------------------------------

describe('§8 un-narrowed output shape', () => {
  it('single topology emits tenant_id and the whole tenant entitlement (spec §8, P-6)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), deps(source));
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([...ENTITLEMENT]);
  });

  it('single topology never carries tenant-admin/users un-narrowed (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event({ groups: [adminGroupName(TENANT_A)] }), deps(source));
    expect(accessGen(result)?.scopesToAdd).not.toContain(SCOPE_TENANT_ADMIN);
  });

  it('multi topology emits a sorted tenants array as a JSON string (spec §8, P-6)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_B), record(TENANT_A)] });
    const result = await handlePreTokenGeneration(event(), deps(source));
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A, TENANT_B] });
    expect(gen?.scopesToAdd).toEqual([...ENTITLEMENT]);
  });

  it('multi topology un-narrowed carries no tenant_id claim (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.claimsToAddOrOverride).not.toHaveProperty('tenant_id');
  });

  it('un-narrowed leaves the ID token untouched (spec §8, ADR-0003)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration).toBeUndefined();
  });

  it('un-narrowed sets no scopesToSuppress and no claimsToSuppress (spec §8)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), deps(source));
    const gen = accessGen(result);
    expect(gen?.scopesToSuppress).toBeUndefined();
    expect(gen?.claimsToSuppress).toBeUndefined();
  });

  it.each([
    ['single, un-narrowed', { kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) }, undefined],
    ['multi, un-narrowed', { kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] }, undefined],
    ['multi, narrowed', { kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] }, { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SAMPLE_READ }],
  ])('%s: overrides cognito:groups with none (P-6, ADR-0020)', async (_label, resolved, meta) => {
    const source = fixedSource(resolved as never);
    const ev = event(meta !== undefined ? { clientMetadata: meta as Record<string, string> } : {});
    const result = await handlePreTokenGeneration(ev, deps(source));
    expect(result.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toEqual({ groupsToOverride: [] });
  });
});

// ---------------------------------------------------------------------------
// §8 status rules (P-2, ADR-0008), including DELETING and absent tenants
// ---------------------------------------------------------------------------

describe('§8 status rules (P-2, ADR-0008)', () => {
  it('single: absent record -> throw (§10 step 10)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: undefined });
    await expect(handlePreTokenGeneration(event(), deps(source))).rejects.toThrow(/^invalid_target: /);
  });

  it('single: DELETING record -> throw (§10 step 10)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'DELETING') });
    await expect(handlePreTokenGeneration(event(), deps(source))).rejects.toThrow(/^invalid_target: /);
  });

  it('multi: drops DELETING tenants, keeps ACTIVE (spec §8, §10 step 10)', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [record(TENANT_A, 'ACTIVE'), record(TENANT_B, 'DELETING')],
    });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A] });
  });

  it('multi: all non-ACTIVE -> throw (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A, 'DELETING')] });
    await expect(handlePreTokenGeneration(event(), deps(source))).rejects.toThrow(/^invalid_target: /);
  });

  it('multi: empty records -> throw (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [] });
    await expect(handlePreTokenGeneration(event(), deps(source))).rejects.toThrow(/^invalid_target: /);
  });
});

// ---------------------------------------------------------------------------
// §8.2 narrowing success (ADR-0010, ADR-0015)
// ---------------------------------------------------------------------------

describe('§8.2 narrowing success (ADR-0010)', () => {
  it('single topology, missing tenant key narrows to the only tenant', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
      deps(source),
    );
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([SAMPLE_READ]);
    expect(gen?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
    expect(gen?.claimsToAddOrOverride).not.toHaveProperty('tenants');
  });

  it('multi topology narrows to a named tenant with exactly the requested scopes', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(
      event({
        groups: [tenantGroupName(TENANT_A), tenantGroupName(TENANT_B)],
        clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: `${SAMPLE_READ} ${SAMPLE_WRITE}` },
      }),
      deps(source),
    );
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([SAMPLE_READ, SAMPLE_WRITE]);
    expect(gen?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
  });

  it('narrowed multi token carries no tenants claim (spec §8 note)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
      deps(source),
    );
    expect(accessGen(result)?.claimsToAddOrOverride).not.toHaveProperty('tenants');
  });

  it('admin scope granted when the user is in admin-<tenant> (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({
        groups: [adminGroupName(TENANT_A)],
        clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SCOPE_TENANT_ADMIN },
      }),
      deps(source),
    );
    expect(accessGen(result)?.scopesToAdd).toEqual([SCOPE_TENANT_ADMIN]);
  });

  it('narrowing a token sets the ID token untouched and suppresses the cognito admin scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
      deps(source),
    );
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration).toBeUndefined();
    expect(accessGen(result)?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
  });

  it('presence of only the scope key (no tenant key) narrows in single topology', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_WRITE } }),
      deps(source),
    );
    expect(accessGen(result)?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
  });

  it('M-13: suppresses every incoming base scope not in the request, plus the cognito admin scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({
        scopes: ['openid', 'email', COGNITO_USER_ADMIN_SCOPE, SAMPLE_READ],
        clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SAMPLE_READ },
      }),
      deps(source),
    );
    const suppress = accessGen(result)?.scopesToSuppress ?? [];
    // openid, email and the cognito admin scope are suppressed; the requested
    // scope survives, and nothing is duplicated.
    expect(suppress).toEqual(expect.arrayContaining(['openid', 'email', COGNITO_USER_ADMIN_SCOPE]));
    expect(suppress).not.toContain(SAMPLE_READ);
    expect(new Set(suppress).size).toBe(suppress.length);
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
  });
});

// ---------------------------------------------------------------------------
// §8.2 narrowing refusals, exact error prefixes (ADR-0010, §5.4)
// ---------------------------------------------------------------------------

describe('§8.2 narrowing refusals (ADR-0010, §5.4)', () => {
  it('tenant not held -> invalid_target, prefix exact, no input echoed', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('refusal message never echoes the requested tenant id', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
        deps(source),
      ),
    ).rejects.toThrow(expect.not.stringContaining(TENANT_B));
  });

  it('tenant DELETING (dropped from active) -> invalid_target', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [record(TENANT_A, 'ACTIVE'), record(TENANT_B, 'DELETING')],
    });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('multi topology without a tenant key -> invalid_target', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    await expect(
      handlePreTokenGeneration(event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_READ } }), deps(source)),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('malformed (non-ULID) tenant key -> invalid_target, value not echoed', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: NOT_A_ULID, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
        deps(source),
      ),
    ).rejects.toThrow(expect.not.stringContaining(NOT_A_ULID));
  });

  it('single topology with a tenant key naming another tenant -> invalid_target', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SAMPLE_READ } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('empty scope string -> invalid_scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: '   ' } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('a scope key present but empty string -> invalid_scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_SCOPE_KEY]: '' } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('unknown scope -> invalid_scope, value not echoed', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: 'made-up/scope' } }),
        deps(source),
      ),
    ).rejects.toThrow(expect.not.stringContaining('made-up/scope'));
  });

  it('duplicate scope -> invalid_scope (documented choice: refuse)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: `${SAMPLE_READ} ${SAMPLE_READ}` } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('admin scope for a non-admin -> invalid_scope (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ groups: [], clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SCOPE_TENANT_ADMIN } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('admin of A narrowing to B asking admin scope -> invalid_scope (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    await expect(
      handlePreTokenGeneration(
        event({
          groups: [tenantGroupName(TENANT_A), tenantGroupName(TENANT_B), adminGroupName(TENANT_A)],
          clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SCOPE_TENANT_ADMIN },
        }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });
});

// ---------------------------------------------------------------------------
// clientMetadata isolation (P-3): only the two §8.2 keys are read
// ---------------------------------------------------------------------------

describe('P-3 clientMetadata isolation', () => {
  it('a clientMetadata "tenant_id" key cannot add a tenant (un-narrowed path)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { tenant_id: TENANT_B, tenants: JSON.stringify([TENANT_B]) } }),
      deps(source),
    );
    // Neither key is a §8.2 key, so this is NOT a narrowing request: the
    // un-narrowed single-topology output stands and names A, never B.
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });

  it('a clientMetadata "tenants" key cannot add tenants in multi topology', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { tenants: JSON.stringify([TENANT_A, TENANT_B]) } }),
      deps(source),
    );
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A] });
  });

  it('arbitrary extra clientMetadata keys alongside the real keys are ignored', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({
        clientMetadata: {
          [NARROW_SCOPE_KEY]: SAMPLE_READ,
          scope: SCOPE_TENANT_ADMIN,
          tenant_id: TENANT_B,
          anything: 'ignored',
        },
      }),
      deps(source),
    );
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });

  it('undefined clientMetadata is handled (no narrowing)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event({ clientMetadata: undefined }), deps(source));
    expect(accessGen(result)?.scopesToSuppress).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error propagation (spec §8 "Failure mode": never swallow)
// ---------------------------------------------------------------------------

describe('§8 failure mode: errors propagate, never swallowed', () => {
  it('an error from the source propagates (e.g. unknown pool, topology 1)', async () => {
    const boom = new Error('unknown pool');
    await expect(
      handlePreTokenGeneration(event(), deps(throwingSource(boom))),
    ).rejects.toBe(boom);
  });

  it('an error from the registry (surfaced via the source) propagates', async () => {
    const outage = new Error('registry outage');
    const source: TenantSource = {
      topology: 'shared-pool',
      resolve: async (_event, registry) => {
        // Exercise the registry so a registry failure is a resolve failure.
        await registry.get('x');
        return { kind: 'single', tenantId: TENANT_A, record: record(TENANT_A), grantedScopes: NO_GRANT };
      },
    };
    const failing: RegistryReader = {
      get: async () => {
        throw outage;
      },
      batchGet: async () => [],
      getByUserPoolId: async () => undefined,
      listScopeNames: async () => [],
    };
    await expect(handlePreTokenGeneration(event(), { source, registry: failing, catalogue: CATALOGUE })).rejects.toBe(outage);
  });
});

// ---------------------------------------------------------------------------
// §8.1 held(user, tenant): catalogue ∩ entitlement ∩ grant (ADR-0035, ADR-0036)
// ---------------------------------------------------------------------------

describe('§8.1 held(user, tenant) (ADR-0034, ADR-0035, ADR-0036)', () => {
  const BILLING = 'billing/read';
  const WIDE = new StaticScopeCatalogue([...ENTITLEMENT, BILLING]);

  it('un-narrowed single token carries the tenant entitlement, not the whole catalogue', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'ACTIVE', [SAMPLE_READ]) });
    const result = await handlePreTokenGeneration(event(), deps(source, WIDE));
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
  });

  it('a tenant entitlement that left the catalogue is not issued (DeleteScope, ADR-0034)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'ACTIVE', [SAMPLE_READ, BILLING]) });
    const result = await handlePreTokenGeneration(event(), deps(source, CATALOGUE));
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
  });

  it('a tenant with no scopes gets a token with no scopes (fail closed, ADR-0035)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'ACTIVE', []) });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.scopesToAdd).toEqual([]);
  });

  it('a row written before ADR-0035 (no scopes field) holds nothing', async () => {
    const legacy = { ...record(TENANT_A) } as { scopes?: readonly string[] };
    delete legacy.scopes;
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: legacy as TenantRecord });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.scopesToAdd).toEqual([]);
  });

  it('a user grant cuts the entitlement (ADR-0036)', async () => {
    const source = fixedSource({
      kind: 'single',
      tenantId: TENANT_A,
      record: record(TENANT_A),
      grantedScopes: () => [SAMPLE_WRITE],
    });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_WRITE]);
  });

  it('an empty grant means the user holds nothing; an absent grant means all (ADR-0036)', async () => {
    const cut = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A), grantedScopes: () => [] });
    expect(accessGen(await handlePreTokenGeneration(event(), deps(cut)))?.scopesToAdd).toEqual([]);
    const all = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A), grantedScopes: () => undefined });
    expect(accessGen(await handlePreTokenGeneration(event(), deps(all)))?.scopesToAdd).toEqual([...ENTITLEMENT]);
  });

  it('a grant cannot add a scope the tenant does not hold (ADR-0035 wins by intersection)', async () => {
    const source = fixedSource({
      kind: 'single',
      tenantId: TENANT_A,
      record: record(TENANT_A, 'ACTIVE', [SAMPLE_READ]),
      grantedScopes: () => [SAMPLE_READ, SAMPLE_WRITE, BILLING],
    });
    const result = await handlePreTokenGeneration(event(), deps(source, WIDE));
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
  });

  it('narrowing to a scope the tenant is not entitled to -> invalid_scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'ACTIVE', [SAMPLE_READ]) });
    await expect(
      handlePreTokenGeneration(event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_WRITE } }), deps(source, WIDE)),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('narrowing to a scope the user was cut from -> invalid_scope', async () => {
    const source = fixedSource({
      kind: 'single',
      tenantId: TENANT_A,
      record: record(TENANT_A),
      grantedScopes: () => [SAMPLE_READ],
    });
    await expect(
      handlePreTokenGeneration(event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_WRITE } }), deps(source)),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('an empty catalogue (cold start, read failed) refuses narrowing and issues no scope', async () => {
    const empty = new StaticScopeCatalogue([]);
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(event({ clientMetadata: { [NARROW_SCOPE_KEY]: SAMPLE_READ } }), deps(source, empty)),
    ).rejects.toThrow(/^invalid_scope: /);
    expect(accessGen(await handlePreTokenGeneration(event(), deps(source, empty)))?.scopesToAdd).toEqual([]);
  });

  it('the admin scope is held through the group even with an empty catalogue (ADR-0015)', async () => {
    const empty = new StaticScopeCatalogue([]);
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'ACTIVE', []) });
    const result = await handlePreTokenGeneration(
      event({ groups: [adminGroupName(TENANT_A)], clientMetadata: { [NARROW_SCOPE_KEY]: SCOPE_TENANT_ADMIN } }),
      deps(source, empty),
    );
    expect(accessGen(result)?.scopesToAdd).toEqual([SCOPE_TENANT_ADMIN]);
  });

  it('un-narrowed multi token carries the intersection of held over the active tenants (ADR-0035)', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [
        record(TENANT_A, 'ACTIVE', [SAMPLE_READ, SAMPLE_WRITE, BILLING]),
        record(TENANT_B, 'ACTIVE', [SAMPLE_READ, BILLING]),
      ],
      grantedScopes: (tenantId) => (tenantId === TENANT_B ? [SAMPLE_READ] : undefined),
    });
    const result = await handlePreTokenGeneration(event(), deps(source, WIDE));
    expect(accessGen(result)?.scopesToAdd).toEqual([SAMPLE_READ]);
  });

  it('multi: a DELETING tenant does not take part in the intersection', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [record(TENANT_A, 'ACTIVE', ENTITLEMENT), record(TENANT_B, 'DELETING', [])],
    });
    const result = await handlePreTokenGeneration(event(), deps(source));
    expect(accessGen(result)?.scopesToAdd).toEqual([...ENTITLEMENT]);
  });

  it('multi: narrowing is checked against held for the TARGET tenant only', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [record(TENANT_A, 'ACTIVE', [SAMPLE_READ]), record(TENANT_B, 'ACTIVE', ENTITLEMENT)],
    });
    const ok = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SAMPLE_WRITE } }),
      deps(source),
    );
    expect(accessGen(ok)?.scopesToAdd).toEqual([SAMPLE_WRITE]);
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SAMPLE_WRITE } }),
        deps(source),
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });
});

// ---------------------------------------------------------------------------
// triggerSource coverage: refresh re-runs the trigger (§8, ADR-0008)
// ---------------------------------------------------------------------------

describe('§8 runs on refresh as well as sign-in', () => {
  it('a refresh event produces the same contract output', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ triggerSource: 'TokenGeneration_RefreshTokens' }),
      deps(source),
    );
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });
});
