// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { TIER_NAMES, type TierName } from './tiers';

/**
 * Result records (spec §4.3): one JSON record per slice per scenario, written
 * by the slice's `run` verb into `$STRESS_RESULTS/<slice>.<scenario>.json`,
 * plus one `lifecycle` record per slice written by the runner. A record
 * holds counts and timings only: never a token, a password or a key.
 */

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface ResultRecord {
  readonly runId: string;
  readonly tier: TierName;
  readonly slice: string;
  /** A scenario id, or `lifecycle` for the runner's deploy and destroy record. */
  readonly scenario: string;
  readonly mode: 'slice' | 'platform';
  /** Commit of each sample in the run, by sample name. */
  readonly commits: Readonly<Record<string, string>>;
  readonly window: { readonly start: string; readonly end: string };
  readonly deploySeconds?: number;
  readonly destroySeconds?: number;
  /** Request counts by `<status>` or `<status>:<reason>`. */
  readonly requests: Readonly<Record<string, number>>;
  /** Seconds per hop (spec §6): `client`, `router`, `origin`, `ingress`, `runtime`, `tools`, ... */
  readonly latency: Readonly<Record<string, Percentiles>>;
  /** P-1: every request is an isolation assertion. */
  readonly isolation: { readonly assertions: number; readonly mismatches: number };
  /** Peak draw on each budgeted quota, by account label. */
  readonly quotas: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** P-7: every refusal names a tenant. */
  readonly refusals: {
    readonly byTenantReason: readonly { readonly tenant: string; readonly reason: string; readonly count: number }[];
    readonly unattributed: number;
  };
  /** Cost above a quiet day, by account label and service, in USD. */
  readonly cost?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function count(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function seconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numberMap(v: unknown, check: (n: unknown) => boolean): boolean {
  return record(v) && Object.values(v).every(check);
}

/** Problems with a parsed record; none when it is a valid `ResultRecord`. */
export function recordProblems(doc: unknown): string[] {
  if (!record(doc)) return ['not an object'];
  const p: string[] = [];
  for (const f of ['runId', 'slice', 'scenario']) {
    if (typeof doc[f] !== 'string' || doc[f] === '') p.push(`${f} must be a non-empty string`);
  }
  if (!(TIER_NAMES as readonly unknown[]).includes(doc.tier)) p.push(`tier must be one of ${TIER_NAMES.join(', ')}`);
  if (doc.mode !== 'slice' && doc.mode !== 'platform') p.push('mode must be slice or platform');
  if (!numberMap(doc.commits, (c) => typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c))) p.push('commits must map sample names to commit ids');
  const w = doc.window;
  if (!record(w) || typeof w.start !== 'string' || typeof w.end !== 'string' || !ISO.test(w.start) || !ISO.test(w.end)) {
    p.push('window.start and window.end must be UTC ISO timestamps');
  } else if (w.end < w.start) {
    p.push('window.end is before window.start');
  }
  for (const f of ['deploySeconds', 'destroySeconds']) {
    if (doc[f] !== undefined && !seconds(doc[f])) p.push(`${f} must be a non-negative number`);
  }
  if (!numberMap(doc.requests, count)) p.push('requests must map statuses to counts');
  if (!numberMap(doc.latency, (l) => record(l) && seconds(l.p50) && seconds(l.p95) && seconds(l.p99) && l.p50 <= l.p95 && l.p95 <= l.p99)) {
    p.push('latency must map hops to ordered p50 <= p95 <= p99 seconds');
  }
  const iso = doc.isolation;
  if (!record(iso) || !count(iso.assertions) || !count(iso.mismatches) || iso.mismatches > iso.assertions) {
    p.push('isolation must hold assertions >= mismatches, both counts');
  }
  if (!numberMap(doc.quotas, (q) => numberMap(q, seconds))) p.push('quotas must map accounts to quota peaks');
  const r = doc.refusals;
  if (
    !record(r) ||
    !count(r.unattributed) ||
    !Array.isArray(r.byTenantReason) ||
    !r.byTenantReason.every((x) => record(x) && typeof x.tenant === 'string' && typeof x.reason === 'string' && count(x.count))
  ) {
    p.push('refusals must hold byTenantReason [{tenant, reason, count}] and unattributed');
  }
  if (doc.cost !== undefined && !numberMap(doc.cost, (c) => numberMap(c, seconds))) p.push('cost must map accounts to services to USD');
  return p;
}

export function parseRecord(text: string, file: string): ResultRecord {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file}: not JSON`);
  }
  const problems = recordProblems(doc);
  if (problems.length > 0) {
    throw new Error(`${file}: ${problems.join('; ')}`);
  }
  return doc as ResultRecord;
}

/**
 * The pass criteria a single record can show (spec §7): a scenario that
 * made isolation assertions (P-1), no mismatch, and no unattributed refusal.
 */
export function recordFailures(r: ResultRecord): string[] {
  const f: string[] = [];
  if (r.scenario !== 'lifecycle' && r.isolation.assertions === 0) f.push(`${r.slice} ${r.scenario}: no isolation assertion (P-1)`);
  if (r.isolation.mismatches > 0) f.push(`${r.slice} ${r.scenario}: ${r.isolation.mismatches} isolation mismatches`);
  if (r.refusals.unattributed > 0) f.push(`${r.slice} ${r.scenario}: ${r.refusals.unattributed} unattributed refusals`);
  return f;
}

function fmt(n: number | undefined, digits = 0): string {
  return n === undefined ? '-' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/**
 * The results file of one run. The runner writes it next to the records;
 * a person checks it and commits it as `stress/results/<date>-<tier>.md`.
 * `runFailures` is every failure the runner found (verbs, missing or
 * refused records, interrupts, pass criteria); when given, the file states
 * the run's verdict and lists them. `report` re-renders from the records
 * alone and leaves the verdict out.
 */
export function renderResults(records: readonly ResultRecord[], runFailures?: readonly string[]): string {
  if (records.length === 0) throw new Error('no result records to render');
  const first = records[0];
  for (const k of ['runId', 'tier', 'mode'] as const) {
    const values = new Set(records.map((r) => r[k]));
    if (values.size !== 1) throw new Error(`records with ${values.size} values of ${k}: ${[...values].join(', ')}`);
  }
  const start = records.map((r) => r.window.start).sort()[0];
  const end = records.map((r) => r.window.end).sort().reverse()[0];
  const commits = new Map<string, string>();
  for (const r of records) for (const [s, c] of Object.entries(r.commits)) commits.set(s, c);
  const failures = records.flatMap(recordFailures);

  const lines = [
    '<!--',
    'Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.',
    'SPDX-License-Identifier: MIT-0',
    '-->',
    `# Platform stress run ${first.runId}: ${first.tier}`,
    '',
    ...(runFailures === undefined
      ? []
      : [`- Run: ${runFailures.length === 0 ? 'PASSED' : `FAILED (${runFailures.length} ${runFailures.length === 1 ? 'failure' : 'failures'}, see below)`}`]),
    `- Window: ${start} to ${end} (UTC)`,
    `- Mode: ${first.mode}`,
    `- Commits: ${[...commits].sort().map(([s, c]) => `${s} ${c.slice(0, 7)}`).join(', ')}`,
    `- Pass criteria (isolation, attribution): ${
      failures.length > 0 ? `not met: ${failures.join('; ')}` : records.some((r) => r.scenario !== 'lifecycle') ? 'met' : 'not evaluated (no scenario records)'
    }`,
    '',
    ...(runFailures === undefined || runFailures.length === 0 ? [] : ['## Failures', '', ...runFailures.map((f) => `- ${f}`), '']),
    '## Deploy and destroy',
    '',
    '| Slice | Deploy (s) | Destroy (s) |',
    '|---|---|---|',
    ...records.filter((r) => r.scenario === 'lifecycle').map((r) => `| ${r.slice} | ${fmt(r.deploySeconds)} | ${fmt(r.destroySeconds)} |`),
    '',
    '## Scenarios',
    '',
    '| Slice | Scenario | Requests | Isolation (mismatches / assertions) | Unattributed refusals | Slowest hop p95 (s) |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of records.filter((x) => x.scenario !== 'lifecycle')) {
    const total = Object.values(r.requests).reduce((a, b) => a + b, 0);
    const slowest = Object.entries(r.latency).sort((a, b) => b[1].p95 - a[1].p95)[0];
    lines.push(
      `| ${r.slice} | ${r.scenario} | ${fmt(total)} | ${fmt(r.isolation.mismatches)} / ${fmt(r.isolation.assertions)} | ${fmt(r.refusals.unattributed)} | ${slowest ? `${slowest[0]} ${fmt(slowest[1].p95, 3)}` : '-'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
