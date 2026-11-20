// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The drain (spec §5.3, ADR-0011, ADR-0034): on stack delete it stops every
 * sandbox before the cluster, the runtime and the image go, waits until the
 * platform lists none live, then lets each backend clean up (`nitro`
 * deregisters its container instances). It runs as the drain role. A sandbox
 * left at the deadline fails the delete loudly: a MicroVM image cannot be
 * deleted while MicroVMs of it live, and a capacity provider not while a
 * task is stopping.
 */

import type { BackendName, RegistryRow, SandboxBackend, SandboxSummary } from '../backend';
import type { ToolConfig } from '../tool/config';
import type { Logger } from '../tool/log';
import type { Registry } from '../tool/registry';
import { handleOf, orphanHandle, stopQuietly, writeStopLine } from '../tool/sandbox';

/** How long the drain waits for sandboxes to end, and how long a backend's cleanup may take (spec §5.3). */
export const DRAIN_BOUND_MS = 600_000;
/** Reads of one row the drain makes while calls keep updating it. */
const MAX_ROW_READS = 4;
/** Pause between two looks at what the platform lists. */
const POLL_MS = 5000;
/** A sandbox still listed this long after its stop is stopped again. */
const RESTOP_MS = 60_000;

export interface DrainDeps {
  readonly config: ToolConfig;
  readonly backends: ReadonlyMap<BackendName, SandboxBackend>;
  readonly registry: Registry;
  readonly log: Logger;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface DrainSummary {
  readonly rowsStopped: number;
  readonly orphansStopped: number;
}

/** DynamoDB's answer for a table that is already gone: nothing to read, which is the same as no rows. */
function tableGone(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

/**
 * `limitMs` is the latest time the drain may still be working (the Lambda's
 * own remaining time, less a margin), so it fails with its own message
 * before the platform kills it with none.
 */
export async function drain(deps: DrainDeps, limitMs: number = Number.POSITIVE_INFINITY): Promise<DrainSummary> {
  const { config, registry, log } = deps;
  const began = deps.now();
  const deadline = Math.min(began + DRAIN_BOUND_MS, limitMs);
  const stats = { rowsStopped: 0, orphansStopped: 0 };
  const stoppedAt = new Map<string, number>();
  const lined = new Set<string>();
  const key = (b: string, h: string) => `${b}|${h}`;
  const idle = config.sandboxIdleMs;

  // 1. Every handle the registry names. Moving READY or STARTING to STOPPING earns this writer the sandbox's one stop line.
  try {
    for await (const row of registry.scan()) {
      const backend = deps.backends.get(row.backend);
      if (backend !== undefined && row.replaces !== undefined) {
        // The sandbox a takeover replaced has its line from that takeover; the drain only makes sure it is stopped.
        lined.add(key(row.backend, row.replaces));
        await stopQuietly(backend, { backend: row.backend, tenantId: row.tenantId, handle: row.replaces, nonce: '' }, log);
        stoppedAt.set(key(row.backend, row.replaces), deps.now());
      }
      if (backend === undefined || row.handle === undefined) continue;
      const handle = { ...row, handle: row.handle };
      const k = key(row.backend, row.handle);
      // A row already STOPPING or FAILED has its line. A READY or STARTING row earns it for whoever moves it.
      let hasLine = row.state === 'STOPPING' || row.state === 'FAILED';
      let moved = false;
      // The row now names another sandbox, or none: whoever replaced or deleted it wrote this sandbox's line.
      let lost = false;
      let cur: RegistryRow = row;
      for (let attempt = 0; attempt < MAX_ROW_READS && !hasLine && !moved; attempt++) {
        moved = await registry.update(cur, { state: 'STOPPING' }) !== undefined;
        if (moved) break;
        const fresh = await registry.get(row.tenantId, row.backend);
        if (fresh?.handle !== row.handle || fresh.nonce !== row.nonce) {
          lost = true;
          break;
        }
        hasLine = fresh.state === 'STOPPING' || fresh.state === 'FAILED';
        cur = fresh;
      }
      const stoppedNow = await stopQuietly(backend, handleOf(handle), log);
      if (stoppedNow) stoppedAt.set(k, deps.now());
      // A row that kept changing under the drain could not be moved. The sandbox is stopped now and nothing else will line it
      // (the sweep below sees it ended), so the drain writes the line, once the stop worked.
      if (moved || (!hasLine && !lost && stoppedNow)) {
        stats.rowsStopped += 1;
        await writeStopLine({ log, backend, row: handle, now: deps.now(), sandboxIdleMs: idle, by: 'drain', reason: 'drain' });
      }
      // A stop that failed leaves the sandbox listed, and the sweep below stops it and writes its one line.
      if (moved || hasLine || lost || stoppedNow) lined.add(k);
    }
  } catch (error) {
    if (!tableGone(error)) throw error;
    log.line('drain_registry_gone', {});
  }

  // 2. Whatever the platform lists, row or not, until none is live.
  for (;;) {
    let live = 0;
    for (const [name, backend] of deps.backends) {
      const summaries: SandboxSummary[] = [];
      for await (const s of backend.list()) if (s.live) summaries.push(s);
      live += summaries.length;
      for (const s of summaries) {
        const k = key(name, s.handle);
        const last = stoppedAt.get(k);
        if (last !== undefined && deps.now() - last < RESTOP_MS) continue;
        if (!await stopQuietly(backend, orphanHandle(s), log)) continue;
        stoppedAt.set(k, deps.now());
        if (!lined.has(k)) {
          lined.add(k);
          stats.orphansStopped += 1;
          await writeStopLine({
            log,
            backend,
            now: deps.now(),
            sandboxIdleMs: idle,
            by: 'drain',
            reason: 'orphan',
            orphan: true,
            row: { tenantId: s.tenantId ?? 'unknown', backend: name, handle: s.handle, createdAt: s.startedAt },
          });
        }
      }
    }
    if (live === 0) break;
    if (deps.now() + POLL_MS > deadline) {
      throw new Error(`drain: ${live} sandbox(es) still live at the deadline; the delete cannot continue`);
    }
    await deps.sleep(POLL_MS);
  }

  // 3. What each backend must still tear down once nothing runs (nitro: the managed instances).
  for (const backend of deps.backends.values()) {
    await backend.cleanup?.(Math.min(deps.now() + DRAIN_BOUND_MS, limitMs));
  }
  log.line('drain', { ...stats, durationMs: deps.now() - began });
  return stats;
}
