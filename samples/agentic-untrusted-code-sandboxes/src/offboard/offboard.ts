// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `offboardTenant` (spec §5.2, ADR-0035): stop one tenant's sandboxes and
 * delete its rows. It runs as the reaper role, which holds the stop actions
 * and no instance action, so it cannot end another tenant's sandbox by ending
 * the instance it shares. It touches only the rows `TENANT#<tenantId>` names.
 *
 * Idempotent: a repeat call stops nothing new and returns the same shape. A
 * sandbox still listed after its stop keeps a `STOPPING` row until the reaper sees
 * it leave the list. The caller removes the tenant's `run_code` grant first, so no call
 * can start a new sandbox in between.
 */

import type { BackendName, SandboxBackend } from '../backend';
import { TENANT_ID_PATTERN } from '../protocol';
import { toolTimeoutMs, type ToolConfig } from '../tool/config';
import type { Logger } from '../tool/log';
import type { Registry, RowKey } from '../tool/registry';
import { handleOf, settleReplaced, stopQuietly, writeStopLine } from '../tool/sandbox';

/** Re-reads one row after losing a race with a call, before giving up on it. */
const MAX_ATTEMPTS = 4;

export interface OffboardDeps {
  readonly config: ToolConfig;
  readonly backends: ReadonlyMap<BackendName, SandboxBackend>;
  readonly registry: Registry;
  readonly log: Logger;
  readonly now: () => number;
}

export interface OffboardResult {
  readonly tenantId: string;
  /** Every sandbox this call stopped. */
  readonly stopped: ReadonlyArray<{ readonly backend: BackendName; readonly handle: string }>;
}

/** Refuses anything but a tenant id (spec §5.1), before any client is built or any row read. */
export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('offboardTenant: tenantId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  }
}

export async function offboardTenant(tenantId: unknown, deps: OffboardDeps): Promise<OffboardResult> {
  assertTenantId(tenantId);
  const { registry, log, config } = deps;
  const stopped = new Map<string, { backend: BackendName; handle: string }>();
  let failures = 0;
  for (const name of config.backends) {
    const backend = deps.backends.get(name);
    if (backend === undefined) continue;
    let settled = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !settled; attempt++) {
      let row = await registry.get(tenantId, name);
      if (row === undefined) {
        settled = true;
        break;
      }
      // A sandbox a takeover replaced is still named on the row: stop it too. Its line is the call's that took the row over;
      // if that call died, this offboard writes it, because it deletes the row and nobody else could.
      const replaced = await settleReplaced({
        row, stopAlways: true, claimAfterMs: toolTimeoutMs(config), backend, registry, log, config, now: deps.now(), by: 'offboard',
      });
      if (replaced.version !== undefined) row = { ...row, version: replaced.version, replacesLined: true };
      // A stop that threw for a sandbox that is already gone is no failure.
      if (!replaced.stopped && row.replaces !== undefined
        && await backend.isAlive({ backend: name, tenantId, handle: row.replaces, nonce: '' })) {
        // The replaced sandbox is still running: keep the row, which names it, and fail the call so it is repeated.
        failures += 1;
        settled = true;
        break;
      }
      let held: RowKey = row;
      if (row.handle !== undefined) {
        const handle = { ...row, handle: row.handle };
        if (row.state === 'READY' || row.state === 'STARTING') {
          // Move the row first: a call that updated it meanwhile wins, and we read it again.
          const moved = await registry.update(row, { state: 'STOPPING' });
          if (moved === undefined) continue;
          held = { ...row, version: moved };
          const stoppedOk = await stopQuietly(backend, handleOf(handle), log);
          await writeStopLine({
            log, backend, row: handle, now: deps.now(), sandboxIdleMs: config.sandboxIdleMs, by: 'offboard', reason: 'offboard',
          });
          if (!stoppedOk) {
            failures += 1;
            settled = true;
            break;
          }
          stopped.set(`${name}|${row.handle}`, { backend: name, handle: row.handle });
          // A task that is still stopping stays listed for a while: keep the row STOPPING so the reaper does not take
          // the sandbox for an orphan and line it a second time; the reaper deletes the row once it has left the list.
          if (await backend.isAlive(handleOf(handle))) {
            settled = true;
            break;
          }
        } else if (await backend.isAlive(handleOf(handle))) {
          // STOPPING or FAILED: its line is written. A sandbox still alive is stopped again.
          if (!await stopQuietly(backend, handleOf(handle), log)) {
            failures += 1;
            settled = true;
            break;
          }
          stopped.set(`${name}|${row.handle}`, { backend: name, handle: row.handle });
          if (await backend.isAlive(handleOf(handle))) {
            // A FAILED row becomes STOPPING, the state the reaper deletes once the sandbox has left the list.
            if (row.state === 'FAILED') await registry.update(row, { state: 'STOPPING' });
            settled = true;
            break;
          }
        }
      }
      settled = await registry.delete(held);
    }
    // A row that kept changing for every read is not offboarded: the caller must know, and may repeat the call.
    if (!settled) failures += 1;
  }
  if (failures > 0) throw new Error(`offboardTenant: ${failures} sandbox(es) or row(s) could not be cleared; repeat the call`);
  return { tenantId, stopped: [...stopped.values()] };
}
