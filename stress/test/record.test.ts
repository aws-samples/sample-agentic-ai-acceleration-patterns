// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { buildRecord } from '../k6/record';
import { parseRecord, recordFailures } from '../src/result';
import { TIERS } from '../src/tiers';

// The shape of the data k6 hands to handleSummary: metric name -> { values }.
const counter = (count: number) => ({ type: 'counter', values: { count, rate: 0 } });
const trend = (med: number, p95: number, p99: number) => ({ type: 'trend', values: { med, 'p(95)': p95, 'p(99)': p99, 'avg': med, 'min': 1, 'max': p99 } });

const ctx = (over: Record<string, unknown> = {}) => ({
  runId: '20261118T150000Z',
  tier: TIERS.small.name,
  slice: 'driver-smoke',
  scenario: 'smoke',
  mode: 'slice',
  commits: { 'driver-smoke': '4bcee84' },
  start: new Date('2026-11-18T15:00:00.000Z'),
  end: new Date('2026-11-18T15:01:00.000Z'),
  ...over,
});

const data = (metrics: Record<string, unknown> = {}) => ({
  metrics: {
    status_200: counter(590),
    status_429: counter(10),
    status_503: counter(0),
    status_other: counter(2),
    refusals_seen: counter(10),
    isolation_assertions: counter(600),
    isolation_mismatch: counter(0),
    client_ms: trend(300, 500, 900),
    ttfb_ms: trend(200, 300, 400),
    ...metrics,
  },
});

describe('the k6 result record (spec §4.3)', () => {
  it('is a record parseRecord accepts', () => {
    const r = parseRecord(JSON.stringify(buildRecord(data(), ctx())), 'record.json');
    expect(r.requests).toEqual({ 200: 590, 429: 10, other: 2 });
    expect(r.latency.client).toEqual({ p50: 0.3, p95: 0.5, p99: 0.9 });
    expect(r.latency['client-ttfb']).toEqual({ p50: 0.2, p95: 0.3, p99: 0.4 });
    expect(r.isolation).toEqual({ assertions: 600, mismatches: 0 });
    expect(r.window).toEqual({ start: '2026-11-18T15:00:00.000Z', end: '2026-11-18T15:01:00.000Z' });
    expect(r.commits).toEqual({ 'driver-smoke': '4bcee84' });
  });

  it('leaves the refusals to the slice: every 4xx and 5xx is unattributed until collect', () => {
    const r = parseRecord(JSON.stringify(buildRecord(data(), ctx())), 'record.json');
    expect(r.refusals).toEqual({ byTenantReason: [], unattributed: 10 });
    expect(recordFailures(r)).toEqual([expect.stringContaining('10 unattributed refusals')]);
  });

  it('keeps the percentiles ordered and drops a hop with no samples', () => {
    const r = parseRecord(JSON.stringify(buildRecord(data({ client_ms: trend(300, 200, 100), ttfb_ms: { type: 'trend', values: {} } }), ctx())), 'record.json');
    expect(r.latency.client).toEqual({ p50: 0.3, p95: 0.3, p99: 0.3 });
    expect(r.latency['client-ttfb']).toBeUndefined();
  });

  it('counts a run with no request at all as zero requests and zero assertions', () => {
    const r = parseRecord(JSON.stringify(buildRecord({ metrics: {} }, ctx())), 'record.json');
    expect(r.requests).toEqual({});
    expect(r.latency).toEqual({});
    expect(recordFailures(r)).toEqual([expect.stringContaining('no isolation assertion')]);
  });

  it('shows a mismatch to the pass criteria', () => {
    const r = parseRecord(JSON.stringify(buildRecord(data({ isolation_mismatch: counter(3) }), ctx())), 'record.json');
    expect(recordFailures(r)).toEqual(expect.arrayContaining([expect.stringContaining('3 isolation mismatches')]));
  });

  it.each(['runId', 'tier', 'slice', 'scenario', 'mode'])('refuses a context without %s', (field) => {
    expect(() => buildRecord(data(), ctx({ [field]: '' }))).toThrow(`the record needs ${field}`);
  });
});
