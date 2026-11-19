// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Recorder, percentiles, reasonOf } from './recorder';

const ID = { runId: 'r1', tier: 'small', mode: 'slice', slice: 'tenant-identity', commit: 'a'.repeat(40) };

describe('percentiles', () => {
  test('nearest rank, ordered', () => {
    const p = percentiles([5, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(p).toEqual({ p50: 5, p95: 10, p99: 10 });
  });

  test('no samples is zeros', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });
});

describe('reasonOf', () => {
  test.each([[429, 'throttled'], [503, 'dependency-throttled'], [404, 'not-found'], [500, 'server-error'], [0, 'network']])('%d is %s', (status, reason) => {
    expect(reasonOf(status)).toBe(reason);
  });

  test('an OAuth error code wins, a free-form one does not', () => {
    expect(reasonOf(400, 'invalid_target')).toBe('invalid_target');
    expect(reasonOf(400, 'Some Message With Spaces')).toBe('bad-request');
  });
});

describe('Recorder', () => {
  test('counts requests, attributes refusals and keeps findings for bare 5xx only', () => {
    const rec = new Recorder();
    rec.observe('platform', 201, 0.2, 'A');
    rec.observe('platform', 429, 0.01, 'A');
    rec.observe('platform', 429, 0.01, 'A');
    rec.observe('platform', 503, 0.5, 'B');
    rec.observe('platform', 0, 0.5, 'B');
    expect(rec.findings).toEqual([]);
    rec.observe('platform', 500, 0.1, 'B');
    const r = rec.toRecord(ID, 'PS-1');
    expect(r.requests).toEqual({ '201': 1, '0:network': 1, '429:throttled': 2, '500:server-error': 1, '503:dependency-throttled': 1 });
    expect(r.refusals.unattributed).toBe(1);
    expect(r.refusals.byTenantReason[0]).toEqual({ tenant: 'A', reason: 'throttled', count: 2 });
    expect(rec.findings).toHaveLength(1);
  });

  test('a mismatch is a finding and a count; a held assertion is only a count', () => {
    const rec = new Recorder();
    rec.assertIsolation(true, 'x', 'A');
    rec.assertIsolation(false, 'y', 'B');
    expect(rec.totals).toMatchObject({ assertions: 2, mismatches: 1 });
    expect(rec.findings[0]).toContain('tenant B');
  });

  test('the record has the shape the platform runner parses and holds no secret-like value', () => {
    const rec = new Recorder();
    rec.observe('token-exchange', 200, 0.12, 'A');
    rec.sample('onboard-ready', 1.5);
    rec.assertIsolation(true, 'x', 'A');
    rec.quotaPeak('cognito-user-authentication-rps', 7);
    rec.quotaPeak('cognito-user-authentication-rps', 4);
    const r = rec.toRecord(ID, 'token-rate', new Date(Date.now() + 1000));
    expect(Object.keys(r).sort()).toEqual(['commits', 'isolation', 'latency', 'mode', 'quotas', 'refusals', 'requests', 'runId', 'scenario', 'slice', 'tier', 'window']);
    expect(r.window.start <= r.window.end).toBe(true);
    expect(r.window.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(r.commits).toEqual({ 'tenant-identity': ID.commit });
    expect(r.quotas).toEqual({ platform: { 'cognito-user-authentication-rps': 7 } });
    const { p50, p95, p99 } = r.latency['token-exchange'];
    expect(p50 <= p95 && p95 <= p99).toBe(true);
    expect(r.latency['onboard-ready'].p50).toBe(1.5);
  });
});
