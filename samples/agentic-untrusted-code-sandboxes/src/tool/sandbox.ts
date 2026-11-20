// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Small helpers the tool, the reaper, the drain and the offboard function share (ADR-0032). */

import type {
  BackendName, RegistryRow, SandboxBackend, SandboxHandle, SandboxSummary, StopFacts, TenantCredentials,
} from '../backend';
import { buildStopLine, errorName, type Logger, type StopRowFacts } from './log';

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
