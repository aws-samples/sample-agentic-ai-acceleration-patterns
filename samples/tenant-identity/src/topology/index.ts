// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PoolPerTenantProvisioner } from './pool-per-tenant';
import type { Provisioner, TenantSource } from './provisioner';
import { SharedPoolProvisioner } from './shared-pool';
import { SharedPoolMultiTenantProvisioner } from './shared-pool-multi-tenant';
import { tenantSourceFor } from './tenant-source';
import { type Deployment, type Topology, topologiesOf } from '../shared/constants';

export type { Provisioner, TenantSource } from './provisioner';
export { bindingHolds, type ArrivedVia } from './binding';

/**
 * ADR-0026: true for the topology whose tenant-user calls run on credentials
 * scoped to the tenant (its own pool, tagged with its id). Kept here so no
 * module outside `src/topology/` names a topology (P-1).
 */
export function usesTenantScopedCredentials(topology: Topology): boolean {
  return topology === 'pool-per-tenant';
}

/** A tenant's strategy, by the topology on its registry row (ADR-0027). */
export type ProvisionersFor = (topology: Topology) => Provisioner;

/** What a provisioner needs, resolved once at cold start from the function environment. */
export interface ProvisionerDeps {
  readonly cognito: CognitoIdentityProviderClient;
  readonly region: string;
  /** shared-pool*: the pool and app client the stack created. */
  readonly sharedPool?: { readonly userPoolId: string; readonly appClientId: string };
  /** pool-per-tenant: the pre-token-generation function attached to every new pool. */
  readonly triggerFunctionArn?: string;
  /** pool-per-tenant: the owning stack, written as the STACK_TAG_KEY tag on new pools. */
  readonly stackName?: string;
}

/** The one place a topology value selects behaviour (spec P-1). */
export function createProvisioner(topology: Topology, deps: ProvisionerDeps): Provisioner {
  switch (topology) {
    case 'pool-per-tenant':
      return new PoolPerTenantProvisioner(deps);
    case 'shared-pool':
      return new SharedPoolProvisioner(deps);
    case 'shared-pool-multi-tenant':
      return new SharedPoolMultiTenantProvisioner(deps);
  }
}

/**
 * ADR-0027: the provisioner for each topology the deployment offers, built
 * lazily and once each. Callers pass the topology on the tenant's registry
 * row, never the deployment. A topology the deployment does not offer is a
 * registry/wiring bug and throws (a 500), never falls back.
 */
export function createProvisioners(deployment: Deployment, deps: ProvisionerDeps): ProvisionersFor {
  const offered = topologiesOf(deployment);
  const built = new Map<Topology, Provisioner>();
  return (topology: Topology) => {
    if (!offered.includes(topology)) {
      throw new Error(`Topology ${topology} is not offered by deployment ${deployment}`);
    }
    let provisioner = built.get(topology);
    if (provisioner === undefined) {
      provisioner = createProvisioner(topology, deps);
      built.set(topology, provisioner);
    }
    return provisioner;
  };
}

export function createTenantSource(deployment: Deployment): TenantSource {
  return tenantSourceFor(deployment);
}
