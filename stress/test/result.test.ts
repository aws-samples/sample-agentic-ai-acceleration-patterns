// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parseRecord, recordFailures, recordProblems, renderResults, type ResultRecord } from '../src/result';

export const record = (over: Partial<ResultRecord> = {}): ResultRecord => ({
  runId: '20261118T150000Z',
  tier: 'small',
  slice: 'agentic-runtime-isolation',
  scenario: 'PS-2',
  mode: 'platform',
  commits: { 'agentic-runtime-isolation': 'f368ad5' },
  window: { start: '2026-11-18T15:00:00Z', end: '2026-11-18T15:01:00Z' },
  requests: { '200': 590, '429:tenant_limited': 10 },
  latency: { client: { p50: 0.3, p95: 0.5, p99: 0.9 }, ingress: { p50: 0.2, p95: 0.3, p99: 0.4 } },
  isolation: { assertions: 600, mismatches: 0 },
  quotas: { 'cell-1': { 'lambda-concurrency': 40 } },
  refusals: { byTenantReason: [{ tenant: 't-1', reason: 'tenant_limited', count: 10 }], unattributed: 0 },
  ...over,
});

describe('result records (spec §4.3)', () => {
  it('accepts a valid record', () => {
    expect(recordProblems(record())).toEqual([]);
    expect(parseRecord(JSON.stringify(record()), 'f').scenario).toBe('PS-2');
  });

  it.each([
    ['tier', { tier: 'huge' }, /tier/],
    ['window order', { window: { start: '2026-11-18T15:01:00Z', end: '2026-11-18T15:00:00Z' } }, /before/],
    ['window format', { window: { start: '2026-11-18 15:00', end: '2026-11-18T15:00:00Z' } }, /ISO/],
    ['commit id', { commits: { a: 'main' } }, /commit ids/],
    ['latency order', { latency: { client: { p50: 1, p95: 0.5, p99: 2 } } }, /p50 <= p95/],
    ['isolation', { isolation: { assertions: 1, mismatches: 2 } }, /assertions >= mismatches/],
    ['refusals', { refusals: { byTenantReason: [{ tenant: 't' }], unattributed: 0 } } as unknown as Partial<ResultRecord>, /refusals/],
    ['negative deploy', { deploySeconds: -1 }, /deploySeconds/],
  ])('names a bad %s', (_n, over, pattern) => {
    expect(recordProblems(record(over as Partial<ResultRecord>)).join('; ')).toMatch(pattern);
  });

  it('fails a record with a mismatch or an unattributed refusal (P-1, P-7)', () => {
    expect(recordFailures(record())).toEqual([]);
    expect(recordFailures(record({ isolation: { assertions: 10, mismatches: 1 }, refusals: { byTenantReason: [], unattributed: 3 } }))).toEqual([
      'agentic-runtime-isolation PS-2: 1 isolation mismatches',
      'agentic-runtime-isolation PS-2: 3 unattributed refusals',
    ]);
  });

  it('renders one run, with lifecycle times and the slowest hop', () => {
    const md = renderResults([
      record(),
      record({ scenario: 'lifecycle', deploySeconds: 424, destroySeconds: 528, requests: {}, latency: {} }),
    ]);
    expect(md).toContain('# Platform stress run 20261118T150000Z: small');
    expect(md).toContain('Pass criteria (isolation, attribution): met');
    expect(md).toContain('| agentic-runtime-isolation | 424 | 528 |');
    expect(md).toContain('| agentic-runtime-isolation | PS-2 | 600 | 0 / 600 | 0 | client 0.500 |');
  });

  it('refuses records of two runs in one file', () => {
    expect(() => renderResults([record(), record({ runId: 'other' })])).toThrow(/2 values of runId/);
    expect(() => renderResults([record(), record({ tier: 'large' })])).toThrow(/2 values of tier/);
    expect(() => renderResults([])).toThrow(/no result records/);
  });
});
