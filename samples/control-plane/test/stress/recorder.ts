// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Collects what one control-plane stress scenario saw and turns it into the result record
 * the platform stress runner reads (`stress/src/result.ts`, spec §4.3): counts and timings
 * only, never a token, a password or a key.
 */

import { type CallResult, reasonOf } from './api';

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** Nearest-rank percentiles of seconds; zeros for no samples. */
export function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: at(50), p95: at(95), p99: at(99) };
}

export interface Identity {
  readonly runId: string;
  readonly tier: string;
  readonly mode: string;
  readonly slice: string;
  readonly commit: string;
}

export interface ResultRecordJson {
  readonly runId: string;
  readonly tier: string;
  readonly slice: string;
  readonly scenario: string;
  readonly mode: string;
  readonly commits: Record<string, string>;
  readonly window: { readonly start: string; readonly end: string };
  readonly requests: Record<string, number>;
  readonly latency: Record<string, Percentiles>;
  readonly isolation: { readonly assertions: number; readonly mismatches: number };
  readonly quotas: Record<string, Record<string, number>>;
  readonly refusals: {
    readonly byTenantReason: { readonly tenant: string; readonly reason: string; readonly count: number }[];
    readonly unattributed: number;
  };
}

/** The tenant of a fleet-wide call (ListCells, ListDeployments by application). */
export const NO_TENANT = '-';

export class Recorder {
  private readonly started: Date;
  private readonly requests = new Map<string, number>();
  private readonly hops = new Map<string, number[]>();
  private readonly refused = new Map<string, number>();
  private assertions = 0;
  private mismatches = 0;
  private unattributed = 0;
  private readonly quotaPeaks = new Map<string, number>();
  /** Problems that fail the scenario. */
  readonly findings: string[] = [];

  constructor(now: Date = new Date()) {
    this.started = now;
  }

  /**
   * One API call. A status of 400 or more is a refusal, attributed to its tenant and the
   * Smithy error type (P-7). A server error, or a refusal of a call that is for no tenant,
   * names no tenant a person can act on: it is unattributed and a finding. A status the
   * caller expected (`expected`) is counted by status and reason but is no refusal.
   */
  observe(hop: string, r: CallResult, tenant: string, expected = false): void {
    const ok = expected || (r.status >= 200 && r.status < 400);
    const reason = reasonOf(r.status, r.errorType);
    const key = r.status >= 200 && r.status < 400 ? String(r.status) : `${r.status}:${reason}${expected ? ':expected' : ''}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.sample(hop, r.seconds);
    if (ok) return;
    if (r.status >= 500 || tenant === NO_TENANT) {
      this.unattributed += 1;
      this.findings.push(`${hop}${tenant === NO_TENANT ? '' : ` for tenant ${tenant}`}: HTTP ${r.status} (${reason})`);
      return;
    }
    const k = `${tenant}\u0000${reason}`;
    this.refused.set(k, (this.refused.get(k) ?? 0) + 1);
  }

  /** A latency that is not one HTTP call: a deployment's onboarding, a cell's create. */
  sample(hop: string, seconds: number): void {
    const samples = this.hops.get(hop) ?? [];
    samples.push(seconds);
    this.hops.set(hop, samples);
  }

  /** One isolation assertion (P-1). A false `held` is a mismatch and a finding. */
  assertIsolation(held: boolean, what: string, tenant: string): void {
    this.assertions += 1;
    if (!held) {
      this.mismatches += 1;
      this.findings.push(`isolation mismatch for ${tenant === NO_TENANT ? 'the fleet' : `tenant ${tenant}`}: ${what}`);
    }
  }

  finding(message: string): void {
    this.findings.push(message);
  }

  quotaPeak(account: string, quota: string, value: number): void {
    const k = `${account}\u0000${quota}`;
    this.quotaPeaks.set(k, Math.max(this.quotaPeaks.get(k) ?? 0, value));
  }

  get totals(): { readonly assertions: number; readonly mismatches: number; readonly requests: number } {
    return { assertions: this.assertions, mismatches: this.mismatches, requests: [...this.requests.values()].reduce((a, b) => a + b, 0) };
  }

  toRecord(id: Identity, scenario: string, now: Date = new Date()): ResultRecordJson {
    const latency: Record<string, Percentiles> = {};
    for (const [hop, samples] of [...this.hops].sort(([a], [b]) => a.localeCompare(b))) latency[hop] = percentiles(samples);
    const quotas: Record<string, Record<string, number>> = {};
    for (const [k, v] of this.quotaPeaks) {
      const [account, quota] = k.split('\u0000');
      quotas[account] = { ...quotas[account], [quota]: v };
    }
    return {
      runId: id.runId,
      tier: id.tier,
      slice: id.slice,
      scenario,
      mode: id.mode,
      commits: { [id.slice]: id.commit },
      window: { start: this.started.toISOString(), end: now.toISOString() },
      requests: Object.fromEntries([...this.requests].sort(([a], [b]) => a.localeCompare(b))),
      latency,
      isolation: { assertions: this.assertions, mismatches: this.mismatches },
      quotas,
      refusals: {
        byTenantReason: [...this.refused]
          .map(([k, count]) => {
            const [tenant, reason] = k.split('\u0000');
            return { tenant, reason, count };
          })
          .sort((a, b) => b.count - a.count || a.tenant.localeCompare(b.tenant) || a.reason.localeCompare(b.reason)),
        unattributed: this.unattributed,
      },
    };
  }
}
