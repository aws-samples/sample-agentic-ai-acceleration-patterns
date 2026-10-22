// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Registry drain for stack teardown (ADR-0022). `cdk destroy` of the
 * pool-per-tenant stack deletes the registry table and the shared trigger,
 * but the per-tenant user pools are created at runtime and belong to no
 * stack: deleting the table orphans them. The teardown custom resource runs
 * this drain on stack Delete so every tenant is offboarded — pool and all —
 * before the table goes.
 *
 * It replays the platform DeleteTenant sequence for each tenant
 * (markDeleting -> provisioner.deprovisionTenant -> registry.delete, R-11),
 * so there is one offboarding path, not two. It is idempotent: a tenant that
 * is already gone from the registry (NotFoundError on markDeleting) is
 * skipped, so a retried or partially-completed drain still converges.
 */

import { NotFoundError } from '../shared/errors';
import { log } from '../shared/logger';
import type { Registry } from '../shared/registry';
import type { Provisioner } from '../topology';

/** Guards against a mispaginating registry: a hard ceiling on Scan pages. */
const MAX_PAGES = 1000;

export interface DrainDeps {
  readonly registry: Registry;
  readonly provisioner: Provisioner;
}

export interface DrainResult {
  /** Tenants whose registry item this run deleted. */
  readonly deleted: number;
}

/**
 * Offboards every tenant in the registry, page by page, until the Scan is
 * exhausted. Logs the tenantId and operation only — never user data (R-10,
 * N-4). Throws on the first unrecoverable error (e.g. a deprovision failure):
 * the custom resource turns that into a FAILED response so CloudFormation
 * does not tear down the table over orphaned pools.
 */
export async function drainTenants(deps: DrainDeps): Promise<DrainResult> {
  const { registry, provisioner } = deps;
  let deleted = 0;
  let nextToken: string | undefined;
  let pages = 0;

  do {
    if (pages >= MAX_PAGES) {
      throw new Error(`Tenant drain exceeded ${MAX_PAGES} pages`);
    }
    pages++;
    const page = await registry.list(nextToken);
    for (const tenant of page.items) {
      const { tenantId } = tenant;
      // R-11: flip to DELETING first. A NotFoundError means the tenant was
      // already removed (a prior, interrupted drain) — skip it, idempotent.
      let deleting;
      try {
        deleting = await registry.markDeleting(tenantId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          log.info('Drain skip (already gone)', { operation: 'drainTenants', tenantId });
          continue;
        }
        throw error;
      }
      log.info('Drain deprovision', { operation: 'drainTenants', tenantId });
      await provisioner.deprovisionTenant(deleting);
      await registry.delete(tenantId);
      deleted++;
    }
    nextToken = page.nextToken;
  } while (nextToken !== undefined);

  log.info('Drain complete', { operation: 'drainTenants', deleted });
  return { deleted };
}
