// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Collects what one stress scenario saw and builds the result record the
 * platform stress runner reads (docs/stress-test.spec.md §4.3,
 * `stress/src/result.ts`): counts and timings only, never a token, a
 * password or a key.
 */

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

export interface RecorderIdentity {
  readonly runId: string;
  readonly tier: string;
  readonly mode: string;
  readonly commit: string;
}

export class Recorder {
  private readonly requests = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  private readonly hops = new Map<string, number[]>();
  private assertions = 0;
  private mismatches = 0;
  private unattributed = 0;
  private readonly problems: string[] = [];
  readonly started = new Date();

  /** One answered request: its status and, for a refusal, its reason and the tenant it is attributed to. */
  request(status: number, refusal?: { readonly tenant: string; readonly reason: string }): void {
    const key = refusal === undefined ? String(status) : `${status}:${refusal.reason}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    if (refusal !== undefined) {
      const k = `${refusal.tenant}\u0000${refusal.reason}`;
      this.refusals.set(k, (this.refusals.get(k) ?? 0) + 1);
    }
  }

  /** A count under a key of its own, in the `<status>:<reason>` form of the record (a success of a hop other than the edge). */
  tally(key: string): void {
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }

  /** The request keys and counts so far. */
  entries(): [string, number][] {
    return [...this.requests];
  }

  /** A refusal the driver could not name a tenant and a reason for (P-7). */
  unattributedRefusal(status: number): void {
    this.requests.set(String(status), (this.requests.get(String(status)) ?? 0) + 1);
    this.unattributed += 1;
  }

  /** An isolation assertion (P-1): `held` is false for a mismatch. */
  assertion(held: boolean, detail?: string): void {
    this.assertions += 1;
    if (!held) {
      this.mismatches += 1;
      if (detail !== undefined && this.problems.length < 20) this.problems.push(`mismatch: ${detail}`);
    }
  }

  /** A seconds sample on a hop. */
  hop(name: string, seconds: number): void {
    const list = this.hops.get(name) ?? [];
    list.push(seconds);
    this.hops.set(name, list);
  }

  /** A pass criterion the scenario broke, by name; the scenario exits non-zero. */
  problem(text: string): void {
    if (this.problems.length < 40) this.problems.push(text);
  }

  get failures(): readonly string[] {
    return this.problems;
  }

  get counts(): { assertions: number; mismatches: number; unattributed: number } {
    return { assertions: this.assertions, mismatches: this.mismatches, unattributed: this.unattributed };
  }

  count(key: string): number {
    return this.requests.get(key) ?? 0;
  }

  samples(name: string): readonly number[] {
    return this.hops.get(name) ?? [];
  }

  build(id: RecorderIdentity, scenario: string, end: Date = new Date()): ResultRecordJson {
    const latency: Record<string, Percentiles> = {};
    for (const [name, list] of this.hops) latency[name] = percentiles(list);
    return {
      runId: id.runId,
      tier: id.tier,
      slice: 'tenant-front-door',
      scenario,
      mode: id.mode,
      commits: { 'tenant-front-door': id.commit },
      window: { start: iso(this.started), end: iso(end) },
      requests: Object.fromEntries([...this.requests].sort(([a], [b]) => a.localeCompare(b))),
      latency,
      isolation: { assertions: this.assertions, mismatches: this.mismatches },
      quotas: {},
      refusals: {
        byTenantReason: [...this.refusals]
          .map(([k, count]) => {
            const [tenant, reason] = k.split('\u0000');
            return { tenant, reason, count };
          })
          .sort((a, b) => a.tenant.localeCompare(b.tenant) || a.reason.localeCompare(b.reason)),
        unattributed: this.unattributed,
      },
    };
  }
}

/** UTC timestamp the result schema accepts: seconds precision or milliseconds, ending in Z. */
export function iso(d: Date): string {
  return d.toISOString();
}
