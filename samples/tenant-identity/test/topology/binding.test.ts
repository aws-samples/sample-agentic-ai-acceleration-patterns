// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Topology } from '../../src/shared/constants';
import type { TenantRecord } from '../../src/shared/registry';
import { bindingHolds } from '../../src/topology/binding';

/** ADR-0027: a tenant is reachable only through its own pool. */

function tenant(topology: Topology, userPoolId?: string): TenantRecord {
  return {
    tenantId: '01HZX9ABCDEFGHJKMNPQRSTVWX',
    name: 't',
    status: 'ACTIVE',
    topology,
    userPoolId,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
}

describe('bindingHolds (ADR-0027)', () => {
  it.each(['shared-pool', 'shared-pool-multi-tenant'] as const)('%s tenant: shared pool only', (topology) => {
    expect(bindingHolds(tenant(topology), { kind: 'shared' })).toBe(true);
    expect(bindingHolds(tenant(topology), { kind: 'pool', userPoolId: 'eu-central-1_A' })).toBe(false);
  });

  it('pool-per-tenant tenant: its own pool only', () => {
    const t = tenant('pool-per-tenant', 'eu-central-1_A');
    expect(bindingHolds(t, { kind: 'pool', userPoolId: 'eu-central-1_A' })).toBe(true);
    expect(bindingHolds(t, { kind: 'pool', userPoolId: 'eu-central-1_B' })).toBe(false);
    expect(bindingHolds(t, { kind: 'shared' })).toBe(false);
  });

  it('pool-per-tenant tenant without a pool (PROVISIONING) is reachable from nowhere', () => {
    const t = tenant('pool-per-tenant');
    expect(bindingHolds(t, { kind: 'pool', userPoolId: 'eu-central-1_A' })).toBe(false);
    expect(bindingHolds(t, { kind: 'shared' })).toBe(false);
  });
});
