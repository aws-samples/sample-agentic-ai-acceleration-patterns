// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import {
  adminGroupName,
  API_SCOPES,
  COGNITO_USER_ADMIN_SCOPE,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_API_READ,
  SCOPE_API_WRITE,
  SCOPE_TENANT_ADMIN,
  tenantGroupName,
} from '../../src/shared/constants';
import type { RegistryReader, TenantRecord, TenantStatus } from '../../src/shared/registry';
import type { ResolvedTenants, TenantSource } from '../../src/topology/provisioner';
import { handlePreTokenGeneration } from '../../src/trigger/pre-token-generation';

/**
 * Unit tests for the pre-token-generation core (spec §8, §8.1, §8.2,
 * ADR-0003, ADR-0008, ADR-0010, ADR-0015). Fakes stand in for the topology
 * TenantSource and the RegistryReader so the core is tested in isolation
 * from any topology implementation (only the shared types are imported).
 */

// Two valid ULIDs (Crockford base32, 26 chars) for the fictional tenants A, B.
const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TENANT_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const NOT_A_ULID = 'not-a-ulid';

function record(tenantId: string, status: TenantStatus = 'ACTIVE'): TenantRecord {
  return {
    tenantId,
    name: `tenant ${tenantId}`,
    status,
    topology: 'shared-pool',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

/** A TenantSource that returns a fixed resolution, ignoring the event. */
function fixedSource(resolved: ResolvedTenants): TenantSource {
  return {
    topology: resolved.kind === 'single' ? 'shared-pool' : 'shared-pool-multi-tenant',
    resolve: async () => resolved,
  };
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
};

interface EventOptions {
  readonly groups?: string[];
  readonly clientMetadata?: Record<string, string>;
  readonly triggerSource?: string;
  readonly sub?: string;
  readonly userName?: string;
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
  it('single topology emits tenant_id and both API scopes (spec §8, P-6)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([...API_SCOPES]);
  });

  it('single topology never carries tenant-admin/users un-narrowed (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event({ groups: [adminGroupName(TENANT_A)] }), {
      source,
      registry: unusedRegistry,
    });
    expect(accessGen(result)?.scopesToAdd).not.toContain(SCOPE_TENANT_ADMIN);
  });

  it('multi topology emits a sorted tenants array as a JSON string (spec §8, P-6)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_B), record(TENANT_A)] });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A, TENANT_B] });
    expect(gen?.scopesToAdd).toEqual([...API_SCOPES]);
  });

  it('multi topology un-narrowed carries no tenant_id claim (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    expect(accessGen(result)?.claimsToAddOrOverride).not.toHaveProperty('tenant_id');
  });

  it('un-narrowed leaves the ID token untouched (spec §8, ADR-0003)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration).toBeUndefined();
  });

  it('un-narrowed sets no scopesToSuppress, no group overrides, no claimsToSuppress (spec §8)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    const gen = accessGen(result);
    expect(gen?.scopesToSuppress).toBeUndefined();
    expect(gen?.claimsToSuppress).toBeUndefined();
    expect(result.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 status rules (P-2, ADR-0008), including DELETING and absent tenants
// ---------------------------------------------------------------------------

describe('§8 status rules (P-2, ADR-0008)', () => {
  it('single: absent record -> throw (§10 step 10)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: undefined });
    await expect(handlePreTokenGeneration(event(), { source, registry: unusedRegistry })).rejects.toThrow();
  });

  it('single: DELETING record -> throw (§10 step 10)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A, 'DELETING') });
    await expect(handlePreTokenGeneration(event(), { source, registry: unusedRegistry })).rejects.toThrow();
  });

  it('multi: drops DELETING tenants, keeps ACTIVE (spec §8, §10 step 10)', async () => {
    const source = fixedSource({
      kind: 'multi',
      records: [record(TENANT_A, 'ACTIVE'), record(TENANT_B, 'DELETING')],
    });
    const result = await handlePreTokenGeneration(event(), { source, registry: unusedRegistry });
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A] });
  });

  it('multi: all non-ACTIVE -> throw (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A, 'DELETING')] });
    await expect(handlePreTokenGeneration(event(), { source, registry: unusedRegistry })).rejects.toThrow();
  });

  it('multi: empty records -> throw (spec §8)', async () => {
    const source = fixedSource({ kind: 'multi', records: [] });
    await expect(handlePreTokenGeneration(event(), { source, registry: unusedRegistry })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §8.2 narrowing success (ADR-0010, ADR-0015)
// ---------------------------------------------------------------------------

describe('§8.2 narrowing success (ADR-0010)', () => {
  it('single topology, missing tenant key narrows to the only tenant', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
      { source, registry: unusedRegistry },
    );
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([SCOPE_API_READ]);
    expect(gen?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
    expect(gen?.claimsToAddOrOverride).not.toHaveProperty('tenants');
  });

  it('multi topology narrows to a named tenant with exactly the requested scopes', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(
      event({
        groups: [tenantGroupName(TENANT_A), tenantGroupName(TENANT_B)],
        clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: `${SCOPE_API_READ} ${SCOPE_API_WRITE}` },
      }),
      { source, registry: unusedRegistry },
    );
    const gen = accessGen(result);
    expect(gen?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
    expect(gen?.scopesToAdd).toEqual([SCOPE_API_READ, SCOPE_API_WRITE]);
    expect(gen?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
  });

  it('narrowed multi token carries no tenants claim (spec §8 note)', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
      { source, registry: unusedRegistry },
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
      { source, registry: unusedRegistry },
    );
    expect(accessGen(result)?.scopesToAdd).toEqual([SCOPE_TENANT_ADMIN]);
  });

  it('narrowing a token sets the ID token untouched and suppresses the cognito admin scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
      { source, registry: unusedRegistry },
    );
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration).toBeUndefined();
    expect(accessGen(result)?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
  });

  it('presence of only the scope key (no tenant key) narrows in single topology', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { [NARROW_SCOPE_KEY]: SCOPE_API_WRITE } }),
      { source, registry: unusedRegistry },
    );
    expect(accessGen(result)?.scopesToSuppress).toEqual([COGNITO_USER_ADMIN_SCOPE]);
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
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('refusal message never echoes the requested tenant id', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
        { source, registry: unusedRegistry },
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
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('multi topology without a tenant key -> invalid_target', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A), record(TENANT_B)] });
    await expect(
      handlePreTokenGeneration(event({ clientMetadata: { [NARROW_SCOPE_KEY]: SCOPE_API_READ } }), {
        source,
        registry: unusedRegistry,
      }),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('malformed (non-ULID) tenant key -> invalid_target, value not echoed', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: NOT_A_ULID, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(expect.not.stringContaining(NOT_A_ULID));
  });

  it('single topology with a tenant key naming another tenant -> invalid_target', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_B, [NARROW_SCOPE_KEY]: SCOPE_API_READ } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_target: /);
  });

  it('empty scope string -> invalid_scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: '   ' } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('a scope key present but empty string -> invalid_scope', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_SCOPE_KEY]: '' } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('unknown scope -> invalid_scope, value not echoed', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: 'made-up/scope' } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(expect.not.stringContaining('made-up/scope'));
  });

  it('duplicate scope -> invalid_scope (documented choice: refuse)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: `${SCOPE_API_READ} ${SCOPE_API_READ}` } }),
        { source, registry: unusedRegistry },
      ),
    ).rejects.toThrow(/^invalid_scope: /);
  });

  it('admin scope for a non-admin -> invalid_scope (ADR-0015)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    await expect(
      handlePreTokenGeneration(
        event({ groups: [], clientMetadata: { [NARROW_TENANT_KEY]: TENANT_A, [NARROW_SCOPE_KEY]: SCOPE_TENANT_ADMIN } }),
        { source, registry: unusedRegistry },
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
        { source, registry: unusedRegistry },
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
      { source, registry: unusedRegistry },
    );
    // Neither key is a §8.2 key, so this is NOT a narrowing request: the
    // un-narrowed single-topology output stands and names A, never B.
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });

  it('a clientMetadata "tenants" key cannot add tenants in multi topology', async () => {
    const source = fixedSource({ kind: 'multi', records: [record(TENANT_A)] });
    const result = await handlePreTokenGeneration(
      event({ clientMetadata: { tenants: JSON.stringify([TENANT_A, TENANT_B]) } }),
      { source, registry: unusedRegistry },
    );
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenants: [TENANT_A] });
  });

  it('arbitrary extra clientMetadata keys alongside the real keys are ignored', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(
      event({
        clientMetadata: {
          [NARROW_SCOPE_KEY]: SCOPE_API_READ,
          scope: SCOPE_TENANT_ADMIN,
          tenant_id: TENANT_B,
          anything: 'ignored',
        },
      }),
      { source, registry: unusedRegistry },
    );
    expect(accessGen(result)?.scopesToAdd).toEqual([SCOPE_API_READ]);
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });

  it('undefined clientMetadata is handled (no narrowing)', async () => {
    const source = fixedSource({ kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) });
    const result = await handlePreTokenGeneration(event({ clientMetadata: undefined }), {
      source,
      registry: unusedRegistry,
    });
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
      handlePreTokenGeneration(event(), { source: throwingSource(boom), registry: unusedRegistry }),
    ).rejects.toBe(boom);
  });

  it('an error from the registry (surfaced via the source) propagates', async () => {
    const outage = new Error('registry outage');
    const source: TenantSource = {
      topology: 'shared-pool',
      resolve: async (_event, registry) => {
        // Exercise the registry so a registry failure is a resolve failure.
        await registry.get('x');
        return { kind: 'single', tenantId: TENANT_A, record: record(TENANT_A) };
      },
    };
    const failing: RegistryReader = {
      get: async () => {
        throw outage;
      },
      batchGet: async () => [],
      getByUserPoolId: async () => undefined,
    };
    await expect(handlePreTokenGeneration(event(), { source, registry: failing })).rejects.toBe(outage);
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
      { source, registry: unusedRegistry },
    );
    expect(accessGen(result)?.claimsToAddOrOverride).toEqual({ tenant_id: TENANT_A });
  });
});
