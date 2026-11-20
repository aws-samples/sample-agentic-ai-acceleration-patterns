// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One reaper pass (spec §4.1, ADR-0011, ADR-0034). It runs as the reaper
 * role, every five minutes, and is idempotent: a second pass over the same
 * state writes no second stop line and stops nothing twice.
 *
 * Before any stop it writes the row with `version = :seen`, so a call that
 * updated the row meanwhile wins. Whoever moves a row out of `STARTING` or
 * `READY` with a successful conditional write writes that sandbox's one stop
 * line; a sandbox no row names (an orphan) gets its line from the sweep.
 */

import type { BackendName, RegistryRow, SandboxBackend, SandboxSummary } from '../backend';
import { handleLessStaleMs, type ToolConfig } from '../tool/config';
import { errorName, type Logger } from '../tool/log';
import type { Registry, RowKey } from '../tool/registry';
import { handleOf, orphanHandle, readStopFacts, settleReplaced, stopQuietly, writeStopLine } from '../tool/sandbox';

/** A failed start backs off this long, as in the tool (spec §4.1). */
const FAIL_BACKOFF_MS = 30_000;
/** Clock difference allowed between the platform's `startedAt` and a row's `createdAt` (ms). */
const CLOCK_SKEW_MS = 5000;

export interface ReaperDeps {
  readonly config: ToolConfig;
  readonly backends: ReadonlyMap<BackendName, SandboxBackend>;
  readonly registry: Registry;
  readonly log: Logger;
  readonly now: () => number;
}

export interface ReaperSummary {
  readonly rows: number;
  /** Sandboxes this pass stopped, rows and orphans together. */
  readonly stopped: number;
  readonly deletedRows: number;
  readonly failedStarts: number;
  readonly orphans: number;
  readonly errors: number;
}

type Handled = RegistryRow & { readonly handle: string };

export async function reapOnce(deps: ReaperDeps): Promise<ReaperSummary> {
  const { config, registry, log } = deps;
  const stats = { rows: 0, stopped: 0, deletedRows: 0, failedStarts: 0, orphans: 0, errors: 0 };
  const err = (what: string, backend: string, error: unknown) => {
    stats.errors += 1;
    log.line('reaper_error', { what, backend, error: errorName(error) });
  };

  // List first, scan second: a sandbox that exists when the scan starts has its row. (spec §4.1 sweep)
  const live = new Map<BackendName, Map<string, SandboxSummary>>();
  const listed = new Set<BackendName>();
  for (const [name, backend] of deps.backends) {
    try {
      const m = new Map<string, SandboxSummary>();
      for await (const s of backend.list()) if (s.live) m.set(s.handle, s);
      live.set(name, m);
      listed.add(name);
    } catch (error) {
      live.set(name, new Map());
      err('list', name, error);
    }
  }

  const known = new Set<string>();
  /**
   * Backend and tenant (`*` for all), mapped to the oldest `createdAt` among young handle-less STARTING rows: a start
   * between its takeover and recording its handle. Only a sandbox started after that row was written can belong to it.
   */
  const youngStarts = new Map<string, number>();
  const young = (k: string, createdAt: number) => youngStarts.set(k, Math.min(youngStarts.get(k) ?? createdAt, createdAt));
  const key = (backend: string, handle: string) => `${backend}|${handle}`;

  /** The row moved out of READY or STARTING by this pass: its one line is written even when the stop call fails (ADR-0033). */
  const stopRow = async (backend: SandboxBackend, row: Handled, reason: string, stoppedReason?: string): Promise<boolean> => {
    const ok = await stopQuietly(backend, handleOf(row), log);
    if (ok) stats.stopped += 1;
    await writeStopLine({
      log, backend, row, now: deps.now(), sandboxIdleMs: config.sandboxIdleMs, by: 'reaper', reason, stoppedReason,
    });
    return ok;
  };

  /** STOPPING with the version seen, then stop and line. Undefined when a call moved the row first, else the row as written and whether the stop worked. */
  const retire = async (backend: SandboxBackend, row: Handled, reason: string): Promise<{ key: RowKey; stopped: boolean } | undefined> => {
    const version = await registry.update(row, { state: 'STOPPING' });
    if (version === undefined) return undefined;
    return { key: { ...row, version }, stopped: await stopRow(backend, row, reason) };
  };

  for await (const scanned of registry.scan()) {
    let row = scanned;
    stats.rows += 1;
    if (row.handle !== undefined) known.add(key(row.backend, row.handle));
    // A takeover names the handle it is replacing until that sandbox is stopped: it is not an orphan, and a stop that failed is retried.
    if (row.replaces !== undefined) known.add(key(row.backend, row.replaces));
    const backend = deps.backends.get(row.backend);
    if (backend === undefined) continue;
    try {
      if (row.replaces !== undefined) {
        const claimed = await settleReplaced({
          row, listed: live.get(row.backend)?.get(row.replaces), backend, registry, log, config, now: deps.now(), by: 'reaper',
        });
        if (claimed !== undefined) row = { ...row, version: claimed, replacesLined: true };
      }
      const now = deps.now();
      const summary = row.handle === undefined ? undefined : live.get(row.backend)?.get(row.handle);
      const expired = now >= row.expiresAt || (summary?.startedAt !== undefined && summary.startedAt + config.sandboxMaxLifeMs <= now);
      const handled = row.handle === undefined ? undefined : { ...row, handle: row.handle };

      if (row.state === 'STOPPING' || row.state === 'FAILED') {
        // Already has its stop line. Stop again only a sandbox the platform still lists.
        // Not listed means gone only when the list worked: a failed list says nothing about the sandbox.
        const notListed = listed.has(row.backend) && summary === undefined;
        const gone = notListed || handled === undefined || await stopQuietly(backend, handleOf(handled), log);
        // A STOPPING row is done when the sandbox has left the list, `isAlive` agrees (`agentcore` lists nothing and is always
        // alive, so its row waits for expiry and the next call's takeover stops the session again), and the sandbox the row
        // replaced is gone as well, so that one is never taken for an orphan.
        const finished = row.state === 'STOPPING' && notListed && handled !== undefined
          && !(live.get(row.backend)?.has(row.replaces ?? '') ?? false) && !(await backend.isAlive(handleOf(handled)));
        // The row stays while a stop is failing: it is what makes the next pass stop the sandbox again. A STOPPING row
        // whose sandbox has left the list has done its work (an offboard keeps it for a task that is still stopping).
        if ((expired || finished) && gone && await registry.delete(row)) stats.deletedRows += 1;
        continue;
      }

      if (expired) {
        if (handled === undefined) {
          if (await registry.delete(row)) stats.deletedRows += 1;
          continue;
        }
        const moved = await retire(backend, handled, 'expired');
        if (moved?.stopped && await registry.delete(moved.key)) stats.deletedRows += 1;
        continue;
      }

      if (row.state === 'READY') {
        if (handled === undefined) continue;
        if (row.backend === 'nitro' && now - (row.lastUsedAt ?? row.createdAt) > config.sandboxIdleMs) {
          await retire(backend, handled, 'idle');
          continue;
        }
        const alive = summary !== undefined || await backend.isAlive(handleOf(handled));
        if (!alive && await registry.delete(row)) {
          // The platform ended it: the delete moved the row out of READY, so this pass owes the line.
          stats.deletedRows += 1;
          await writeStopLine({
            log, backend, row: handled, now, sandboxIdleMs: config.sandboxIdleMs, by: 'reaper', reason: 'gone',
          });
        }
        continue;
      }

      // STARTING
      if (handled === undefined) {
        if (now - row.createdAt <= handleLessStaleMs(config)) {
          young(key(row.backend, row.tenantId), row.createdAt);
          young(key(row.backend, '*'), row.createdAt);
        }
        continue;
      }
      // The tool's rule for a start (spec §4.1) from what the reaper role can see: the sandbox ended, or its lease ran out.
      // `ready` is the tool's own probe and may need what this role does not have, so the reaper does not call it. A start
      // whose lease ran out is stopped even when it became ready: nobody came back for it within the cap.
      const alive = summary !== undefined || await backend.isAlive(handleOf(handled));
      let failed: string | undefined;
      if (!alive) failed = (await readStopFacts(backend, handleOf(handled))).reason ?? 'ended';
      else if (now >= (row.leaseUntil ?? row.createdAt + backend.startCapMs)) failed = 'start_cap';
      if (failed === undefined) continue;
      if (await registry.update(row, { state: 'FAILED', retryAt: now + FAIL_BACKOFF_MS }) === undefined) continue;
      stats.failedStarts += 1;
      if (alive) await stopRow(backend, handled, 'failed_start', failed);
      else await writeStopLine({ log, backend, row: handled, now, sandboxIdleMs: config.sandboxIdleMs, by: 'reaper', reason: 'failed_start', stoppedReason: failed });
    } catch (error) {
      err('row', row.backend, error);
    }
  }

  // Orphans: live sandboxes of this deployment that no row names. AgentCore has no list, so none there.
  for (const [name, summaries] of live) {
    const backend = deps.backends.get(name);
    if (backend === undefined || !listed.has(name)) continue;
    for (const s of summaries.values()) {
      if (known.has(key(name, s.handle))) continue;
      const shield = youngStarts.get(key(name, s.tenantId ?? '*'));
      if (shield !== undefined && (s.startedAt === undefined || s.startedAt >= shield - CLOCK_SKEW_MS)) continue;
      try {
        // No row remembers an orphan: its line is written once it is stopped, and a failed stop is tried again next pass.
        if (!await stopQuietly(backend, orphanHandle(s), log)) continue;
        stats.stopped += 1;
        stats.orphans += 1;
        await writeStopLine({
          log,
          backend,
          now: deps.now(),
          sandboxIdleMs: config.sandboxIdleMs,
          by: 'reaper',
          reason: 'orphan',
          orphan: true,
          row: { tenantId: s.tenantId ?? 'unknown', backend: name, handle: s.handle, createdAt: s.startedAt },
        });
      } catch (error) {
        err('orphan', name, error);
      }
    }
  }

  log.line('reaper', stats);
  if (stats.errors > 0) throw new Error(`reaper pass finished with ${stats.errors} error(s)`);
  return stats;
}
