// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { reasonOf } from './api';
import { NO_TENANT, percentiles, Recorder } from './recorder';

const ID = { runId: 'r1', tier: 'small', mode: 'slice', slice: 'control-plane', commit: '0123456' };

describe('Recorder', () => {
  it('attributes a refusal to its tenant and Smithy error type (P-7)', () => {
    const rec = new Recorder(new Date('2026-11-20T10:00:00Z'));
    rec.observe('create', { status: 202, body: {}, seconds: 0.1 }, 'T1');
    rec.observe('create', { status: 409, errorType: 'InsufficientCapacityError', body: {}, seconds: 0.2 }, 'T2');
    const r = rec.toRecord(ID, 'placement-race', new Date('2026-11-20T10:01:00Z'));
    expect(r.requests).toEqual({ '202': 1, '409:insufficient-capacity': 1 });
    expect(r.refusals).toEqual({ byTenantReason: [{ tenant: 'T2', reason: 'insufficient-capacity', count: 1 }], unattributed: 0 });
    expect(r.window).toEqual({ start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:01:00.000Z' });
    expect(r.commits).toEqual({ 'control-plane': '0123456' });
  });

  it('counts a server error, or a refusal of a call for no tenant, as unattributed and a finding', () => {
    const rec = new Recorder();
    rec.observe('get', { status: 500, body: {}, seconds: 1 }, 'T1');
    rec.observe('list-cells', { status: 403, body: {}, seconds: 1 }, NO_TENANT);
    expect(rec.toRecord(ID, 's').refusals.unattributed).toBe(2);
    expect(rec.findings).toHaveLength(2);
  });

  it('counts an expected status by status and reason but not as a refusal', () => {
    const rec = new Recorder();
    rec.observe('get-deployment', { status: 404, errorType: 'ResourceNotFoundError', body: {}, seconds: 0.1 }, 'T1', true);
    const r = rec.toRecord(ID, 's');
    expect(r.requests).toEqual({ '404:resource-not-found:expected': 1 });
    expect(r.refusals).toEqual({ byTenantReason: [], unattributed: 0 });
  });

  it('counts isolation assertions and mismatches (P-1) and keeps quota peaks by account', () => {
    const rec = new Recorder();
    rec.assertIsolation(true, 'x', 'T1');
    rec.assertIsolation(false, 'cell over its limit', NO_TENANT);
    rec.quotaPeak('platform', 'codebuild-linux-small', 3);
    rec.quotaPeak('platform', 'codebuild-linux-small', 2);
    const r = rec.toRecord(ID, 's');
    expect(r.isolation).toEqual({ assertions: 2, mismatches: 1 });
    expect(r.quotas).toEqual({ platform: { 'codebuild-linux-small': 3 } });
    expect(rec.findings).toEqual(['isolation mismatch for the fleet: cell over its limit']);
  });

  it('turns samples into ordered nearest-rank percentiles', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
    expect(percentiles([3, 1, 2, 4])).toEqual({ p50: 2, p95: 4, p99: 4 });
  });
});

describe('reasonOf', () => {
  it('turns a Smithy error type into a reason word, and falls back to the status', () => {
    expect(reasonOf(409, 'ConflictError')).toBe('conflict');
    expect(reasonOf(400, 'ValidationException')).toBe('validation');
    expect(reasonOf(429)).toBe('throttled');
    expect(reasonOf(0)).toBe('network');
    expect(reasonOf(409, 'not a type!')).toBe('conflict');
  });
});
