// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Small helpers the tool, the reaper, the drain and the offboard function share (ADR-0032). */

import type {
  BackendName, RegistryRow, SandboxBackend, SandboxHandle, SandboxSummary, StopFacts, TenantCredentials,
} from '../backend';
import { handleLessStaleMs, type ToolConfig } from './config';
import { buildStopLine, errorName, type Logger, type StopRowFacts } from './log';
import type { Registry, StoredRow } from './registry';

/** The handle a backend takes, from a row that has one. */
export function handleOf(row: RegistryRow & { readonly handle: string }): SandboxHandle {
  return {
    backend: row.backend,
    tenantId: row.tenantId,
    handle: row.handle,
    address: row.address,
    nonce: row.nonce,
    bootId: row.bootId,
  };
}

/** The handle of a sandbox the platform listed that no row names. Its nonce is unknown, and a stop does not use it. */
export function orphanHandle(summary: SandboxSummary): SandboxHandle {
  return { backend: summary.backend, tenantId: summary.tenantId ?? 'unknown', handle: summary.handle, nonce: '' };
}

/** What the platform says about a stopped sandbox; `{}` when it cannot say. */
export async function readStopFacts(backend: SandboxBackend, handle: SandboxHandle): Promise<StopFacts> {
  try {
    return await backend.stopReason(handle);
  } catch {
    return {};
  }
}

/**
 * Stops a sandbox and reports whether the stop call succeeded. It never
 * throws: a failed stop leaves the sandbox to the reaper's sweep, and the
 * caller's own outcome does not depend on it. The error's class name goes in
 * the log, nothing else.
 */
export async function stopQuietly(
  backend: SandboxBackend,
  handle: SandboxHandle,
  log: Logger,
  creds?: TenantCredentials,
): Promise<boolean> {
  try {
    await backend.stop(handle, creds);
    return true;
  } catch (error) {
    log.line('stop_failed', { tenantId: handle.tenantId, backend: handle.backend, handle: handle.handle, error: errorName(error) });
    return false;
  }
}

/** Writes the one stop line of a sandbox (spec §3.8), reading the platform's facts after the stop. */
export async function writeStopLine(args: {
  readonly log: Logger;
  readonly backend: SandboxBackend;
  readonly row: StopRowFacts;
  readonly now: number;
  readonly sandboxIdleMs: number;
  readonly by: string;
  readonly reason: string;
  /** Why a start failed (`start_cap`, or the reason the probe saw): it wins over the platform's later reason. */
  readonly stoppedReason?: string;
  readonly orphan?: boolean;
}): Promise<void> {
  const handle: SandboxHandle = { backend: args.row.backend, tenantId: args.row.tenantId, handle: args.row.handle, nonce: '' };
  const facts = await readStopFacts(args.backend, handle);
  args.log.stop(buildStopLine({
    row: args.row,
    facts: { ...facts, reason: args.stoppedReason ?? facts.reason },
    now: args.now,
    sandboxIdleMs: args.sandboxIdleMs,
    by: args.by,
    reason: args.reason,
    orphan: args.orphan,
  }));
}

export function backendOf(map: ReadonlyMap<BackendName, SandboxBackend>, name: BackendName): SandboxBackend {
  const b = map.get(name);
  if (b === undefined) throw new Error(`backend ${name} is not enabled`);
  return b;
}

/**
 * A row written by a takeover names the sandbox it replaced (`replaces`), so no sweep takes that sandbox for an orphan
 * while it stops (ADR-0034). The reaper and the drain call this for each such row. The sandbox is stopped again if it is
 * still listed (`stopAlways` for the drain), silently, because the call that took the row over writes its line. When that
 * call died first, the row is old and `replacesLined` is still false: one writer claims the line with a conditional write,
 * stops the sandbox, and writes it. A `replaces` that is the row's own handle, or that the platform says belongs to
 * another tenant, is ignored. Returns the row's new version when this call claimed the line.
 */
export async function settleReplaced(args: {
  readonly row: StoredRow;
  readonly listed?: SandboxSummary;
  readonly stopAlways?: boolean;
  /** Claim the line whatever the row's age: the caller deletes the row, so nobody else could write it later (offboard). */
  readonly claimNow?: boolean;
  readonly backend: SandboxBackend;
  readonly registry: Registry;
  readonly log: Logger;
  readonly config: ToolConfig;
  readonly now: number;
  readonly by: string;
}): Promise<number | undefined> {
  const { row, listed, backend, log, config } = args;
  if (row.replaces === undefined || row.replaces === '' || row.replaces === row.handle) return undefined;
  if (listed?.tenantId !== undefined && listed.tenantId !== row.tenantId) return undefined;
  const owed = row.replacesLined !== true && (args.claimNow === true || args.now - row.createdAt > handleLessStaleMs(config));
  const claimedVersion = owed ? await args.registry.update(row, { replacesLined: true }) : undefined;
  const claimed = claimedVersion !== undefined;
  if (listed !== undefined || args.stopAlways || claimed) {
    await stopQuietly(backend, { backend: row.backend, tenantId: row.tenantId, handle: row.replaces, nonce: '' }, log);
  }
  if (claimed) {
    await writeStopLine({
      log,
      backend,
      now: args.now,
      sandboxIdleMs: config.sandboxIdleMs,
      by: args.by,
      reason: 'replaced',
      row: { tenantId: row.tenantId, backend: row.backend, handle: row.replaces, createdAt: listed?.startedAt },
    });
  }
  return claimedVersion;
}
