// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// The result record of one scenario (docs/stress-test.spec.md §4.3, stress/src/result.ts
// `ResultRecord`), built from the end-of-test data k6 hands to handleSummary.
//
// No k6 imports here, so the same file runs under k6 and under the contract's jest tests,
// which check that `parseRecord` accepts what this builds. It holds counts and timings only:
// never a token, a password or a key.
//
// What a record built here leaves for the slice's `collect` verb (spec §3.4):
// - refusals.byTenantReason is empty and refusals.unattributed is the number of 4xx and 5xx
//   responses the driver saw. `collect` may join the per-tenant lines the library prints
//   (kind `tenant_minute`), if it uses them, with the hops' logs and moves the attributed ones
//   into byTenantReason (P-7). A scenario with refusals and no `collect` fails the run, which is
//   the point: an unattributed refusal is a finding.
// - cost is absent: `collect` adds it.

const STATUS_METRIC = /^status_(\d+|other)$/;

function value(metrics, name, key) {
  const m = metrics[name];
  const v = m && m.values ? m.values[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** p50, p95 and p99 in seconds of a Trend recorded in milliseconds, or null without samples. */
function hop(metrics, name) {
  const m = metrics[name];
  const v = m && m.values;
  if (!v || typeof v.med !== 'number' || typeof v['p(95)'] !== 'number' || typeof v['p(99)'] !== 'number') {
    return null;
  }
  const p50 = v.med / 1000;
  const p95 = Math.max(p50, v['p(95)'] / 1000);
  const p99 = Math.max(p95, v['p(99)'] / 1000);
  return { p50, p95, p99 };
}

/**
 * `data` is k6's handleSummary argument. `ctx`: runId, tier (name), slice, scenario, mode,
 * commits ({sample: commit}), start and end (Date). Throws on a field the record cannot lack.
 */
export function buildRecord(data, ctx) {
  for (const f of ['runId', 'tier', 'slice', 'scenario', 'mode']) {
    if (typeof ctx[f] !== 'string' || ctx[f] === '') {
      throw new Error(`the record needs ${f}`);
    }
  }
  const metrics = data.metrics || {};
  const requests = {};
  for (const name of Object.keys(metrics)) {
    const m = STATUS_METRIC.exec(name);
    const count = value(metrics, name, 'count');
    if (m && count > 0) {
      requests[m[1]] = count;
    }
  }
  const latency = {};
  const client = hop(metrics, 'client_ms');
  if (client) latency.client = client;
  const ttfb = hop(metrics, 'ttfb_ms');
  if (ttfb) latency['client-ttfb'] = ttfb;
  return {
    runId: ctx.runId,
    tier: ctx.tier,
    slice: ctx.slice,
    scenario: ctx.scenario,
    mode: ctx.mode,
    commits: ctx.commits,
    window: { start: ctx.start.toISOString(), end: ctx.end.toISOString() },
    requests,
    latency,
    isolation: {
      assertions: value(metrics, 'isolation_assertions', 'count'),
      mismatches: value(metrics, 'isolation_mismatch', 'count'),
    },
    quotas: {},
    refusals: { byTenantReason: [], unattributed: value(metrics, 'refusals_seen', 'count') },
  };
}
