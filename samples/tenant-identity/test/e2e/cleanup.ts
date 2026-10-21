// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * preDestroy cleanup for the deployment integration test (test/integ.identity.ts).
 *
 * `cdk destroy` can remove the stacks, but it cannot remove what the platform
 * API created *inside* Cognito at run time: in `pool-per-tenant` every tenant
 * owns a user pool created by `CreateTenant`, and in the shared pools every
 * tenant owns groups and users. `DeleteTenant` is the only thing that removes
 * them (spec P-4). The e2e scenario deletes every tenant it creates, but a
 * failed or interrupted run can leave a tenant behind; this script deletes any
 * tenant still in each stack's registry through the platform API, so teardown
 * is total and `pool-per-tenant` leaves no pools (spec §6.2, §10 step 11).
 *
 * It runs as integ-runner's preDestroy hook, whose working directory is the
 * snapshot's parent, not the sample. It therefore depends on nothing in the
 * cwd: it discovers each stack through CloudFormation and signs platform calls
 * with the ambient credentials (spec §3.2). Best-effort: a missing stack or a
 * failed delete is logged and skipped so teardown always proceeds.
 *
 * Reads AWS_REGION and E2E_STACK_PREFIX (default TenantIdentity) from the
 * environment, exactly as the e2e task does.
 */

import { discoverStack, PlatformClient } from './clients';
import { TOPOLOGIES, Topology } from '../../src/shared/constants';

async function drainTenants(topology: Topology): Promise<void> {
  let stack;
  try {
    stack = await discoverStack(topology);
  } catch (error) {
    // Stack not deployed (or already destroyed) — nothing to clean.
    console.log(`[cleanup] ${topology}: no stack, skipping (${(error as Error).message})`);
    return;
  }
  const platform = new PlatformClient(stack.apiUrl);

  let deleted = 0;
  let nextToken: string | undefined;
  // List, then delete; re-list until empty (a page may shrink as we delete).
  for (let guard = 0; guard < 1000; guard++) {
    const list = await platform.call<{
      tenants: { tenantId: string }[];
      nextToken?: string;
    }>('GET', nextToken === undefined ? 'platform/tenants' : `platform/tenants?nextToken=${encodeURIComponent(nextToken)}`);
    if (list.status !== 200) {
      console.log(`[cleanup] ${topology}: ListTenants returned ${list.status}, stopping`);
      return;
    }
    const tenants = list.body?.tenants ?? [];
    for (const t of tenants) {
      try {
        await platform.call('DELETE', `platform/tenants/${t.tenantId}`);
        deleted++;
      } catch (error) {
        console.log(`[cleanup] ${topology}: DeleteTenant ${t.tenantId} failed: ${(error as Error).message}`);
      }
    }
    nextToken = list.body?.nextToken;
    if (nextToken === undefined) {
      if (tenants.length === 0) {
        break;
      }
      // Deleted a page with no further token; re-scan from the start in case
      // DELETING items linger (DeleteTenant is idempotent, spec R-11).
      nextToken = undefined;
      const recheck = await platform.call<{ tenants: { tenantId: string }[] }>(
        'GET',
        'platform/tenants',
      );
      if ((recheck.body?.tenants ?? []).length === 0) {
        break;
      }
    }
  }
  console.log(`[cleanup] ${topology}: deleted ${deleted} tenant(s)`);
}

async function main(): Promise<void> {
  for (const topology of TOPOLOGIES) {
    await drainTenants(topology);
  }
}

main().catch((error) => {
  // Never fail the destroy on a cleanup error — log and exit 0.
  console.log(`[cleanup] error: ${(error as Error).message}`);
  process.exit(0);
});
