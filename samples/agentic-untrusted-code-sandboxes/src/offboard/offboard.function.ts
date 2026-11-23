// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of `offboardTenant` (spec §5.2, ADR-0035). The vendor's
 * tenant delete script invokes it with IAM and `{ "tenantId": "…" }`. It
 * runs as the reaper role. A bad `tenantId` or a sandbox that could not be
 * stopped is a Lambda error, because the caller is a script that must not
 * go on as if the tenant were gone.
 */

import { assertTenantId, offboardTenant, type OffboardDeps, type OffboardResult } from './offboard';
import { loadConfig } from '../tool/config';
import { loadBackends, registryClient } from '../tool/deps';
import { Logger } from '../tool/log';

let deps: OffboardDeps | undefined;

function build(): OffboardDeps {
  const config = loadConfig();
  return {
    config,
    backends: loadBackends(config),
    registry: registryClient(config.table),
    log: new Logger(undefined, config.perTenantMetrics),
    now: Date.now,
  };
}

export async function handler(event: { readonly tenantId?: unknown } | undefined): Promise<OffboardResult> {
  assertTenantId(event?.tenantId);
  deps ??= build();
  return offboardTenant(event.tenantId, deps);
}
