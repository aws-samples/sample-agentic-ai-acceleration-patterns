// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tenant sources for the pre-token-generation trigger (spec §8 "Tenant
 * lookup"). One per topology; each reads the event and the registry only,
 * and returns the tenant(s) the token should name. The trigger (W1) applies
 * the status rule and narrowing on top of this; the source only maps an
 * event to tenant ids.
 *
 * This module MUST NOT import the Cognito SDK: the trigger's role holds no
 * `cognito-idp` action (R-14), and nothing here needs one.
 */

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import type { ResolvedTenants, TenantSource } from './provisioner';
import { INVALID_TARGET, isTenantId, TENANT_ATTRIBUTE, TENANT_GROUP_PATTERN, type Topology } from '../shared/constants';
import { InvalidInputError } from '../shared/errors';
import type { RegistryReader } from '../shared/registry';

/** Selects the tenant source for the deploy-time topology (spec P-1, P-7). */
export function tenantSourceFor(topology: Topology): TenantSource {
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
    return { kind: 'single', tenantId: record.tenantId, record };
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
    return { kind: 'single', tenantId, record };
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
    return { kind: 'multi', records };
  }
}
