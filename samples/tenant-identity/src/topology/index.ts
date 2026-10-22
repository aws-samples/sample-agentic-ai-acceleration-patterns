// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PoolPerTenantProvisioner } from './pool-per-tenant';
import type { Provisioner, TenantSource } from './provisioner';
import { SharedPoolProvisioner } from './shared-pool';
import { SharedPoolMultiTenantProvisioner } from './shared-pool-multi-tenant';
import { tenantSourceFor } from './tenant-source';
import type { Topology } from '../shared/constants';

export type { Provisioner, TenantSource } from './provisioner';

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

export function createTenantSource(topology: Topology): TenantSource {
  return tenantSourceFor(topology);
}
