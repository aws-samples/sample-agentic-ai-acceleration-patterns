// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tenant sources for the pre-token-generation trigger (spec §8 "Tenant
 * lookup"). One per topology; each reads the event and the registry only,
 * and returns the tenant(s) the token should name, plus the user's granted
 * scopes per tenant in the topology's `custom:scopes` encoding (ADR-0036).
 * The trigger (W1) applies the status rule, the scope rule and narrowing on
 * top of this; the source only maps an event to tenant ids and grants.
 *
 * This module MUST NOT import the Cognito SDK: the trigger's role holds no
 * `cognito-idp` action (R-14), and nothing here needs one.
 */

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { bindingHolds } from './binding';
import type { ResolvedTenants, TenantSource } from './provisioner';
import {
  type Deployment,
  INVALID_TARGET,
  isTenantId,
  POOL_MISMATCH,
  SCOPES_ATTRIBUTE,
  TENANT_ATTRIBUTE,
  TENANT_GROUP_PATTERN,
  TIERED,
  type Topology,
} from '../shared/constants';
import { InvalidInputError } from '../shared/errors';
import type { RegistryReader } from '../shared/registry';
import { decodeScopeList, decodeScopeMapEntry } from '../shared/scopes';

/**
 * ADR-0036: the single-tenant reading of `custom:scopes` (a space-separated
 * list). The attribute is for the user's one tenant, so the id is ignored.
 */
function listGrants(event: PreTokenGenerationV2TriggerEvent): (tenantId: string) => readonly string[] | undefined {
  const granted = decodeScopeList(event.request.userAttributes?.[SCOPES_ATTRIBUTE]);
  return () => granted;
}

/** ADR-0036: the multi-tenant reading of `custom:scopes` (a JSON object keyed by tenant id). */
function mapGrants(event: PreTokenGenerationV2TriggerEvent): (tenantId: string) => readonly string[] | undefined {
  const value = event.request.userAttributes?.[SCOPES_ATTRIBUTE];
  return (tenantId) => decodeScopeMapEntry(value, tenantId);
}

/**
 * Selects the tenant source for the deployment (spec P-1, P-7). Every source
 * applies the ADR-0027 binding rule to the rows it reads, so a tenant is
 * only ever named through its own pool.
 */
export function tenantSourceFor(deployment: Deployment): TenantSource {
  if (deployment === TIERED) {
    return new TieredTenantSource();
  }
  return singleTenantSourceFor(deployment);
}

function singleTenantSourceFor(topology: Topology): TenantSource {
  switch (topology) {
    case 'pool-per-tenant':
      return new PoolPerTenantTenantSource();
    case 'shared-pool':
      return new SharedPoolTenantSource();
    case 'shared-pool-multi-tenant':
      return new SharedPoolMultiTenantTenantSource();
  }
}

/**
 * pool-per-tenant: the event's pool identifies the tenant (spec §4.2). An
 * event from a pool the registry does not know is a pool the sample did not
 * create; throw, so no token leaves it with a tenant claim.
 */
class PoolPerTenantTenantSource implements TenantSource {
  readonly topology: Topology = 'pool-per-tenant';

  async resolve(event: PreTokenGenerationV2TriggerEvent, registry: RegistryReader): Promise<ResolvedTenants> {
    const record = await registry.getByUserPoolId(event.userPoolId);
    if (record === undefined) {
      // invalid_target prefix: the exchange maps an absent tenant to
      // invalid_target, not invalid_grant (spec §5.4). Fixed text only.
      throw new Error(`${INVALID_TARGET}: unknown user pool`);
    }
    // ADR-0027: the index row must be a pool-per-tenant tenant naming this
    // pool. Always true for rows the platform wrote; checked so a stray
    // index entry can never name a shared-pool tenant.
    if (!bindingHolds(record, { kind: 'pool', userPoolId: event.userPoolId })) {
      throw new Error(`${INVALID_TARGET}: ${POOL_MISMATCH}`);
    }
    return { kind: 'single', tenantId: record.tenantId, record, grantedScopes: listGrants(event) };
  }
}

/**
 * shared-pool: the immutable custom attribute names the tenant (spec §7.2).
 * The attribute must be a ULID; anything else is a corrupt pool, not a
 * caller choice (P-3).
 */
class SharedPoolTenantSource implements TenantSource {
  readonly topology: Topology = 'shared-pool';

  async resolve(event: PreTokenGenerationV2TriggerEvent, registry: RegistryReader): Promise<ResolvedTenants> {
    const tenantId = event.request.userAttributes[TENANT_ATTRIBUTE];
    if (!isTenantId(tenantId)) {
      throw new InvalidInputError(`${INVALID_TARGET}: user has no valid tenant attribute`);
    }
    const record = await registry.get(tenantId);
    // ADR-0027: a premium (pool-per-tenant) tenant's id in the attribute is
    // a vendor bug, never a way in: the tenant is reachable only through its
    // own pool.
    if (record !== undefined && !bindingHolds(record, { kind: 'shared' })) {
      throw new Error(`${INVALID_TARGET}: ${POOL_MISMATCH}`);
    }
    return { kind: 'single', tenantId, record, grantedScopes: listGrants(event) };
  }
}

/**
 * shared-pool-multi-tenant: every `t-<id>` group the user holds names a
 * tenant (spec §7.3). Groups matching neither `t-` nor `admin-` are ignored
 * (reserved for further roles, §11). Only tenants present in the registry
 * are returned; the trigger drops non-ACTIVE ones on top.
 */
class SharedPoolMultiTenantTenantSource implements TenantSource {
  readonly topology: Topology = 'shared-pool-multi-tenant';

  async resolve(event: PreTokenGenerationV2TriggerEvent, registry: RegistryReader): Promise<ResolvedTenants> {
    const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
    const tenantIds: string[] = [];
    for (const group of groups) {
      const match = TENANT_GROUP_PATTERN.exec(group);
      if (match !== null) {
        tenantIds.push(match[1]);
      }
    }
    const records = await registry.batchGet(tenantIds);
    // ADR-0027: drop any tenant not bound to the shared pool.
    return {
      kind: 'multi',
      records: records.filter((r) => bindingHolds(r, { kind: 'shared' })),
      grantedScopes: mapGrants(event),
    };
  }
}

/**
 * `tiered` (ADR-0027): one trigger on the shared pool and every premium pool.
 * The event's shape says which pool it came from: only the shared pool's
 * schema has `custom:tenantId` (§7.2), and premium pools have no such
 * attribute (§7.1). So an event with the attribute takes the shared-pool
 * path, and any other takes the pool lookup. Each path then applies the
 * binding rule, so a premium tenant cannot be named from the shared pool and
 * a standard tenant cannot be named from a premium pool.
 */
class TieredTenantSource implements TenantSource {
  readonly topology: Topology = 'shared-pool';
  private readonly shared = new SharedPoolTenantSource();
  private readonly perTenant = new PoolPerTenantTenantSource();

  resolve(event: PreTokenGenerationV2TriggerEvent, registry: RegistryReader): Promise<ResolvedTenants> {
    const fromSharedPool = event.request.userAttributes[TENANT_ATTRIBUTE] !== undefined;
    return (fromSharedPool ? this.shared : this.perTenant).resolve(event, registry);
  }
}
