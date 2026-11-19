// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The decisions inside the driver's `seed`, `sweep` and `collect` verbs, with
 * the AWS and HTTP calls passed in, so unit tests can drive them with mocked
 * clients (`steps.test.ts`). `driver.ts` wires them to the real clients.
 */

import type { Manifest, ManifestTenant } from './manifest';
import { Recorder } from './recorder';
import type { HttpResult } from '../e2e/clients';

// ---------------------------------------------------------------------------
// seed: reconcile the manifest with the pool
// ---------------------------------------------------------------------------

export type ReadTenant = (tenantId: string) => Promise<HttpResult<{ tenant?: { status?: string } }>>;

export interface Reconciled {
  /** Seeded tenants that read back 200 ACTIVE: reused as they are. */
  readonly kept: readonly ManifestTenant[];
  /** Beyond the tier's count (a tier that shrank): stay in `seeded` for `sweep --seeded`. */
  readonly surplus: readonly ManifestTenant[];
  /** Read back 404: gone from the pool, safe to forget. */
  readonly gone: readonly string[];
  /**
   * There but not usable (PROVISIONING, DELETING, SUSPENDED), or no answer
   * after the retries (429, 5xx, transport): still in the pool, so they move
   * to `transient` and `teardown` deletes them. Never forgotten.
   */
  readonly stale: readonly string[];
}

/** Sorts the manifest's seeded tenants by how they read back. `read` does its own retries. */
export async function reconcileSeeded(
  seeded: readonly ManifestTenant[],
  want: number,
  read: ReadTenant,
  beforeEach: () => Promise<void> = async () => undefined,
): Promise<Reconciled> {
  const kept: ManifestTenant[] = [];
  const gone: string[] = [];
  const stale: string[] = [];
  for (const t of seeded.slice(0, want)) {
    await beforeEach();
    const r = await read(t.tenantId);
    if (r.status === 200 && r.body?.tenant?.status === 'ACTIVE') {
      kept.push(t);
    } else if (r.status === 404) {
      gone.push(t.tenantId);
    } else {
      stale.push(t.tenantId);
    }
  }
  return { kept, surplus: seeded.slice(want), gone, stale };
}

/** The manifest after reconciliation: `kept` and `surplus` stay seeded, `stale` joins `transient`. */
export function applyReconciled(m: Manifest, r: Reconciled): Manifest {
  return {
    ...m,
    seeded: [...r.kept, ...r.surplus],
    transient: [...new Set([...m.transient, ...r.stale])],
  };
}

/**
 * A Recorder that also counts the 5xx answers per UTC minute, so `collect`
 * can take seed's own 5xx out of API Gateway's count (they share minutes
 * with the first scenario). Status 0 never reached the API and is not counted.
 */
export class MinuteRecorder extends Recorder {
  readonly fiveXxPerMinute: Record<string, number> = {};

  constructor(private readonly clock: () => number = Date.now) {
    super();
  }

  override observe(hop: string, status: number, seconds: number, tenant: string, oauthError?: string): void {
    super.observe(hop, status, seconds, tenant, oauthError);
    if (status >= 500) {
      const minute = new Date(Math.floor(this.clock() / MINUTE) * MINUTE).toISOString();
      this.fiveXxPerMinute[minute] = (this.fiveXxPerMinute[minute] ?? 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepStore {
  readonly seeded: readonly ManifestTenant[];
  readonly transient: readonly string[];
  update(change: (m: Manifest) => Manifest): void;
  removeTransient(ids: readonly string[]): void;
}

export interface SweepOps {
  /** True on 204 or 404 (DeleteTenant resumes where it stopped). */
  deleteOne(tenantId: string): Promise<boolean>;
  /** The status a read of the tenant answers, after retries. */
  readStatus(tenantId: string): Promise<number>;
  beforeEach?(): Promise<void>;
}

export interface Swept {
  readonly ids: readonly string[];
  readonly failed: number;
  /** Deleted, yet a read did not answer 404. */
  readonly left: number;
}

/** The ids `sweep` deletes: every transient one, plus the seeded set with `--seeded`. */
export function sweepIds(store: Pick<SweepStore, 'seeded' | 'transient'>, includeSeeded: boolean): string[] {
  return [...new Set([...store.transient, ...(includeSeeded ? store.seeded.map((t) => t.tenantId) : [])])];
}

/**
 * Deletes each id, takes it off the manifest only once DeleteTenant answered
 * 204 or 404, then reads every deleted one back and counts what still reads
 * as anything but 404. A failed delete stays on the manifest for a rerun.
 */
export async function sweepTenants(store: SweepStore, includeSeeded: boolean, ops: SweepOps): Promise<Swept> {
  const ids = sweepIds(store, includeSeeded);
  let failed = 0;
  const deleted: string[] = [];
  for (const id of ids) {
    await ops.beforeEach?.();
    if (await ops.deleteOne(id)) {
      deleted.push(id);
      store.removeTransient([id]);
      if (includeSeeded) {
        store.update((m) => ({ ...m, seeded: m.seeded.filter((t) => t.tenantId !== id) }));
      }
    } else {
      failed += 1;
    }
  }
  let left = 0;
  for (const id of deleted) {
    if ((await ops.readStatus(id)) !== 404) {
      left += 1;
    }
  }
  return { ids, failed, left };
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

export const MINUTE = 60_000;

export interface RecordDoc {
  window: { start: string; end: string };
  requests: Record<string, number>;
  refusals: { unattributed: number };
}

export interface Window {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Each record's window widened to whole CloudWatch minutes (`[floor(start),
 * ceil(end))`), sorted, and merged where two share or touch a minute. The
 * gaps between scenarios are left out: in `platform` mode another slice
 * calls the same API there, and its 5XX are not this slice's.
 */
export function windowsOf(docs: readonly Pick<RecordDoc, 'window'>[]): Window[] {
  const spans = docs
    .map((d) => ({
      start: Math.floor(Date.parse(d.window.start) / MINUTE) * MINUTE,
      end: Math.max(Math.ceil(Date.parse(d.window.end) / MINUTE) * MINUTE, Math.floor(Date.parse(d.window.start) / MINUTE) * MINUTE + MINUTE),
    }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged.map((m) => ({ start: new Date(m.start), end: new Date(m.end) }));
}

/** Calls that reached the API (status 0 did not) and the 5xx among them, over every record. */
export function driverCounts(docs: readonly Pick<RecordDoc, 'requests'>[]): { reached: number; seen5xx: number } {
  let reached = 0;
  let seen5xx = 0;
  for (const d of docs) {
    for (const [k, n] of Object.entries(d.requests)) {
      if (!k.startsWith('0:')) reached += n;
      if (/^5\d\d/.test(k)) seen5xx += n;
    }
  }
  return { reached, seen5xx };
}

/** Seed's 5xx in the minutes `[start, end)`: API Gateway counted them too, but no record holds them. */
export function seed5xxIn(perMinute: Readonly<Record<string, number>> | undefined, start: Date, end: Date): number {
  return Object.entries(perMinute ?? {})
    .filter(([minute]) => {
      const t = Date.parse(minute);
      return t >= start.getTime() && t < end.getTime();
    })
    .reduce((a, [, n]) => a + n, 0);
}

export interface Collected {
  /** The minutes the metrics were summed over: one per scenario, merged where they overlap. */
  readonly windows: readonly Window[];
  readonly reached: number;
  readonly counted: number;
  readonly api5xx: number;
  readonly seen5xx: number;
  readonly seed5xx: number;
  /** API Gateway 5XX nobody saw: unattributed refusals (P-7). */
  readonly extra: number;
  /** False when `Count` stayed under 90% of `reached` past the deadline: `extra` is then not trustworthy. */
  readonly caughtUp: boolean;
}

export interface CollectOps {
  /** Sum of an AWS/ApiGateway metric of the API over `[start, end)`. */
  apiSum(metric: 'Count' | '5XXError', start: Date, end: Date): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Waits for API Gateway's `Count` to reach 90% of the calls the driver made
 * (CloudWatch delivers late, finding F-6), up to `waitMs`, then takes
 * `5XXError` minus the 5xx the scenarios saw and minus seed's 5xx in the same
 * minutes. Every metric is summed per scenario window (`windowsOf`), never
 * over the span from the first to the last, so the gaps between scenarios are
 * not counted. If `Count` never caught up the result says so, and the verb
 * fails (P-7: a late 5XX must not pass unseen).
 */
export async function collectFiveXx(
  docs: readonly RecordDoc[],
  seedPerMinute: Readonly<Record<string, number>> | undefined,
  ops: CollectOps,
  waitMs = 4 * MINUTE,
  pollMs = 20_000,
): Promise<Collected> {
  const windows = windowsOf(docs);
  const { reached, seen5xx } = driverCounts(docs);
  const seed5xx = windows.reduce((a, w) => a + seed5xxIn(seedPerMinute, w.start, w.end), 0);
  const sum = async (metric: 'Count' | '5XXError'): Promise<number> => {
    let total = 0;
    for (const w of windows) {
      total += await ops.apiSum(metric, w.start, w.end);
    }
    return total;
  };
  const deadline = ops.now() + waitMs;
  let counted = await sum('Count');
  while (counted < 0.9 * reached && ops.now() < deadline) {
    await ops.sleep(pollMs);
    counted = await sum('Count');
  }
  const caughtUp = counted >= 0.9 * reached;
  const api5xx = await sum('5XXError');
  const extra = Math.max(0, Math.round(api5xx - seen5xx - seed5xx));
  return { windows, reached, counted, api5xx, seen5xx, seed5xx, extra, caughtUp };
}

/** The record the leftover goes on: the one whose window ends last. */
export function latestOf<T extends { doc: Pick<RecordDoc, 'window'> }>(docs: readonly T[]): T {
  return docs.reduce((a, b) => (Date.parse(b.doc.window.end) >= Date.parse(a.doc.window.end) ? b : a));
}
