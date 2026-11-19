// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Collects what one stress scenario saw and turns it into the result record
 * the platform stress runner reads (`stress/src/result.ts`, spec §4.3): counts
 * and timings only, never a token, a password or a key.
 */

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** Nearest-rank percentiles of seconds; zeros for no samples. */
export function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: at(50), p95: at(95), p99: at(99) };
}

/** The reason word for a status that has no better one in the body. */
export function reasonOf(status: number, oauthError?: string): string {
  if (oauthError !== undefined && /^[a-z_]{1,40}$/.test(oauthError)) {
    return oauthError;
  }
  switch (status) {
    case 0: return 'network';
    case 400: return 'bad-request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 409: return 'conflict';
    case 429: return 'throttled';
    case 503: return 'dependency-throttled';
    default: return status >= 500 ? 'server-error' : 'refused';
  }
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

export interface Identity {
  readonly runId: string;
  readonly tier: string;
  readonly mode: string;
  readonly slice: string;
  readonly commit: string;
}

export class Recorder {
  private readonly started = new Date();
  private readonly requests = new Map<string, number>();
  private readonly hops = new Map<string, number[]>();
  private readonly refused = new Map<string, number>();
  private assertions = 0;
  private mismatches = 0;
  private unattributed = 0;
  private readonly quotaPeaks = new Map<string, number>();
  /** Problems that fail the scenario but have no field in the record. */
  readonly findings: string[] = [];

  /**
   * One HTTP call. `status` 0 is a transport failure. A status of 400 or more
   * is a refusal attributed to `tenant` and a reason (P-7). A bare server
   * error other than the retryable 503 has no reason a caller can act on: it
   * counts as unattributed and as a finding (spec P-7). A transport failure
   * names its tenant, so it is a refusal, and fails the scenario only when
   * the operation never completes.
   */
  observe(hop: string, status: number, seconds: number, tenant: string, oauthError?: string): void {
    const ok = status >= 200 && status < 400;
    const reason = reasonOf(status, oauthError);
    const key = ok ? String(status) : `${status}:${reason}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const samples = this.hops.get(hop) ?? [];
    samples.push(seconds);
    this.hops.set(hop, samples);
    if (!ok) {
      const k = `${tenant}\u0000${reason}`;
      this.refused.set(k, (this.refused.get(k) ?? 0) + 1);
      if (status >= 500 && status !== 503) {
        this.unattributed += 1;
        this.findings.push(`${hop} for tenant ${tenant}: HTTP ${status} (${reason})`);
      }
    }
  }

  /** A latency that is not one HTTP call: a tenant's whole onboarding. */
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
      this.findings.push(`isolation mismatch for tenant ${tenant}: ${what}`);
    }
  }

  /** A failure that is not an isolation assertion (an operation that never completed). */
  finding(message: string): void {
    this.findings.push(message);
  }

  quotaPeak(quota: string, value: number): void {
    this.quotaPeaks.set(quota, Math.max(this.quotaPeaks.get(quota) ?? 0, value));
  }

  get totals(): { readonly assertions: number; readonly mismatches: number; readonly requests: number } {
    return {
      assertions: this.assertions,
      mismatches: this.mismatches,
      requests: [...this.requests.values()].reduce((a, b) => a + b, 0),
    };
  }

  toRecord(id: Identity, scenario: string, now: Date = new Date()): ResultRecordJson {
    const latency: Record<string, Percentiles> = {};
    for (const [hop, samples] of [...this.hops].sort(([a], [b]) => a.localeCompare(b))) {
      latency[hop] = percentiles(samples);
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
      quotas: this.quotaPeaks.size === 0 ? {} : { platform: Object.fromEntries(this.quotaPeaks) },
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
