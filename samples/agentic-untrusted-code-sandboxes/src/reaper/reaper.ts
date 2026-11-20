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
import type { Registry } from '../tool/registry';
import { handleOf, orphanHandle, stopQuietly, writeStopLine } from '../tool/sandbox';

/** A failed start backs off this long, as in the tool (spec §4.1). */
const FAIL_BACKOFF_MS = 30_000;

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
  /** Backends with a young handle-less STARTING row, and the tenants it names: a start between its takeover and recording its handle. */
  const youngStarts = new Set<string>();
  const key = (backend: string, handle: string) => `${backend}|${handle}`;

  const stopRow = async (backend: SandboxBackend, row: Handled, reason: string): Promise<void> => {
    await stopQuietly(backend, handleOf(row), log);
    stats.stopped += 1;
    await writeStopLine({
      log, backend, row, now: deps.now(), sandboxIdleMs: config.sandboxIdleMs, by: 'reaper', reason,
    });
  };

  /** STOPPING with the version seen, then stop and line; true when this pass moved the row. */
  const retire = async (backend: SandboxBackend, row: Handled, reason: string): Promise<number | undefined> => {
    const version = await registry.update(row.tenantId, row.backend, row.version, { state: 'STOPPING' });
    if (version === undefined) return undefined;
    await stopRow(backend, row, reason);
    return version;
  };

  for await (const row of registry.scan()) {
    stats.rows += 1;
    if (row.handle !== undefined) known.add(key(row.backend, row.handle));
    const backend = deps.backends.get(row.backend);
    if (backend === undefined) continue;
    try {
      const now = deps.now();
      const summary = row.handle === undefined ? undefined : live.get(row.backend)?.get(row.handle);
      const expired = now >= row.expiresAt || (summary?.startedAt !== undefined && summary.startedAt + config.sandboxMaxLifeMs <= now);
      const handled = row.handle === undefined ? undefined : { ...row, handle: row.handle };

      if (row.state === 'STOPPING' || row.state === 'FAILED') {
        // Already has its stop line. Stop again only a sandbox the platform still lists.
        if (summary !== undefined && handled !== undefined) await stopQuietly(backend, handleOf(handled), log);
        if (expired && await registry.delete(row.tenantId, row.backend, row.version)) stats.deletedRows += 1;
        continue;
      }

      if (expired) {
        if (handled === undefined) {
          if (await registry.delete(row.tenantId, row.backend, row.version)) stats.deletedRows += 1;
          continue;
        }
        const version = await retire(backend, handled, 'expired');
        if (version !== undefined && await registry.delete(row.tenantId, row.backend, version)) stats.deletedRows += 1;
        continue;
      }

      if (row.state === 'READY') {
        if (handled === undefined) continue;
        if (row.backend === 'nitro' && now - (row.lastUsedAt ?? row.createdAt) > config.sandboxIdleMs) {
          await retire(backend, handled, 'idle');
          continue;
        }
        const alive = summary !== undefined || await backend.isAlive(handleOf(handled));
        if (!alive && await registry.delete(row.tenantId, row.backend, row.version)) {
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
          youngStarts.add(key(row.backend, row.tenantId));
          youngStarts.add(key(row.backend, '*'));
        }
        continue;
      }
      const probe = await backend.ready(handleOf(handled), handled);
      let failed: string | undefined;
      if (probe.state === 'ended') failed = probe.reason;
      else if (probe.state === 'starting' && now >= (row.leaseUntil ?? row.createdAt + backend.startCapMs)) failed = 'start_cap';
      if (failed === undefined) continue;
      const version = await registry.update(row.tenantId, row.backend, row.version, { state: 'FAILED', retryAt: now + FAIL_BACKOFF_MS });
      if (version === undefined) continue;
      stats.failedStarts += 1;
      await stopQuietly(backend, handleOf(handled), log);
      stats.stopped += 1;
      await writeStopLine({
        log, backend, row: handled, now, sandboxIdleMs: config.sandboxIdleMs, by: 'reaper', reason: 'failed_start', stoppedReason: failed,
      });
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
      if (youngStarts.has(key(name, s.tenantId ?? '*'))) continue;
      try {
        await stopQuietly(backend, orphanHandle(s), log);
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
