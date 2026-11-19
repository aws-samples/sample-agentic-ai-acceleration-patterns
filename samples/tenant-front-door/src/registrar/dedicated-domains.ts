// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { DeploymentRecord } from './control-plane';
import { refuse } from './errors';
import type { RouteStore } from './route-store';
import type { TenantEntry } from '../shared/route-table';
import type { PutTenantRouteServerOutput } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * The seam for dedicated domains (spec §3.4 step 5 sub-steps 1 to 6,
 * ADR-0018): the domain challenge, the ACM certificate, the dedicated
 * distribution tenant and the `host#<d>` write. Build slice S6 implements
 * it; wave 1 ships `DedicatedDomainsNotBuilt`.
 *
 * The registrar has already run every check that does not need ACM,
 * CloudFront or DNS when it calls `putTenantDomain`: the caller is the edge
 * operator role, `dedicatedDomains` is on, the domain is outside
 * `appDomain`, the `tenant#` entry exists and matches the deployment's
 * `accountId` and `createdAt`, its cell route exists with the entry's
 * account, and no `host#<customDomain>` names another tenant (§3.4 steps
 * 3 and 4). Those checks rest on one read; the implementation repeats them
 * on its own ETag conflicts (§3.4 step 5, last paragraphs).
 */
export interface DomainRequest {
  /** Stored (lower-case) tenant id. */
  readonly tenantId: string;
  /** The tenant id as the caller sent it, echoed in the answer. */
  readonly requestTenantId: string;
  readonly customDomain: string;
  /** The `tenant#` entry the checks read. */
  readonly entry: TenantEntry;
  readonly deployment: DeploymentRecord;
  readonly store: RouteStore;
}

export interface DedicatedDomains {
  /** The operator's `PutTenantRoute` with a `customDomain`: 200 once routed, 202 while pending. */
  putTenantDomain(request: DomainRequest): Promise<PutTenantRouteServerOutput>;

  /**
   * Called after a write removed a tenant's `d` and its `host#<d>` (a
   * dropped or changed domain, a deleted or replaced tenant route, a
   * cleared `host#` key): disables the domain's distribution tenant, after
   * checking its tags name this tenant and this distribution. The sweeper
   * deletes it and its certificate later (two-phase removal).
   */
  releaseDomain(tenantId: string, domain: string): Promise<void>;
}

/** Wave 1: no ACM, CloudFront or DNS side yet. */
export class DedicatedDomainsNotBuilt implements DedicatedDomains {
  async putTenantDomain(): Promise<PutTenantRouteServerOutput> {
    throw refuse.internal('dedicated domains are not built yet');
  }

  async releaseDomain(): Promise<void> {
    // Nothing to disable: wave 1 creates no distribution tenant.
  }
}
