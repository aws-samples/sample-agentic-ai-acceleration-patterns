// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { emptyManifest, type Manifest, type ManifestTenant } from './manifest';
import {
  applyReconciled,
  collectFiveXx,
  driverCounts,
  latestOf,
  MINUTE,
  MinuteRecorder,
  reconcileSeeded,
  seed5xxIn,
  sweepTenants,
  type SweepStore,
  windowsOf,
} from './steps';

const tenant = (id: string, name = `s-${id}`): ManifestTenant => ({ tenantId: id, name, admin: { username: `${id}-a`, email: `${id}@x` }, users: [] });

class MemoryStore implements SweepStore {
  constructor(public m: Manifest) {}
  get seeded(): readonly ManifestTenant[] { return this.m.seeded; }
  get transient(): readonly string[] { return this.m.transient; }
  update(change: (m: Manifest) => Manifest): void { this.m = change(this.m); }
  removeTransient(ids: readonly string[]): void {
    this.m = { ...this.m, transient: this.m.transient.filter((id) => !ids.includes(id)) };
  }
}

describe('seed reconciliation', () => {
  const answers: Record<string, { status: number; body?: { tenant?: { status?: string } } }> = {
    A: { status: 200, body: { tenant: { status: 'ACTIVE' } } },
    B: { status: 404 },
    C: { status: 200, body: { tenant: { status: 'DELETING' } } },
    D: { status: 429 },
    E: { status: 503 },
    F: { status: 0 },
    G: { status: 200, body: { tenant: { status: 'PROVISIONING' } } },
    H: { status: 200, body: { tenant: { status: 'ACTIVE' } } },
  };
  const read = async (id: string) => answers[id] as never;

  test('keeps ACTIVE, forgets only 404, and queues everything else for teardown', async () => {
    const seeded = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => tenant(id));
    const r = await reconcileSeeded(seeded, 7, read);
    expect(r.kept.map((t) => t.tenantId)).toEqual(['A']);
    expect(r.gone).toEqual(['B']);
    expect(r.stale).toEqual(['C', 'D', 'E', 'F', 'G']);
    // H is beyond the tier's count: surplus, not read, still seeded.
    expect(r.surplus.map((t) => t.tenantId)).toEqual(['H']);

    const m = applyReconciled({ ...emptyManifest('p', 'p-identity', 'small', 'c'), seeded, transient: ['X', 'C'] }, r);
    expect(m.seeded.map((t) => t.tenantId)).toEqual(['A', 'H']);
    expect(m.transient).toEqual(['X', 'C', 'D', 'E', 'F', 'G']);
    // Nothing that may still be in the pool is dropped from the manifest.
    const tracked = new Set([...m.seeded.map((t) => t.tenantId), ...m.transient]);
    expect(seeded.map((t) => t.tenantId).filter((id) => !tracked.has(id))).toEqual(['B']);
  });

  test('a minute recorder counts seed 5xx per UTC minute, not transport failures', () => {
    let now = Date.parse('2026-11-19T10:00:30Z');
    const rec = new MinuteRecorder(() => now);
    rec.observe('x', 503, 0.1, 'A');
    rec.observe('x', 500, 0.1, 'A');
    rec.observe('x', 0, 0.1, 'A');
    rec.observe('x', 201, 0.1, 'A');
    now += MINUTE;
    rec.observe('x', 503, 0.1, 'A');
    expect(rec.fiveXxPerMinute).toEqual({ '2026-11-19T10:00:00.000Z': 2, '2026-11-19T10:01:00.000Z': 1 });
  });
});

describe('sweep', () => {
  test('takes a tenant off the manifest only once deleted, and counts what still reads', async () => {
    const store = new MemoryStore({ ...emptyManifest('p', 'p-identity', 'small', 'c'), seeded: [tenant('S1'), tenant('S2')], transient: ['T1', 'T2', 'S1'] });
    const deleteOne = jest.fn(async (id: string) => id !== 'T2');
    const readStatus = jest.fn(async (id: string) => (id === 'S2' ? 200 : 404));
    const r = await sweepTenants(store, true, { deleteOne, readStatus });
    expect(r.ids).toEqual(['T1', 'T2', 'S1', 'S2']);
    expect(r).toMatchObject({ failed: 1, left: 1 });
    expect(store.transient).toEqual(['T2']);
    expect(store.seeded).toEqual([]);
    // Only deleted ids are read back.
    expect(readStatus.mock.calls.map(([id]) => id)).toEqual(['T1', 'S1', 'S2']);
  });

  test('without --seeded the seeded set stays', async () => {
    const store = new MemoryStore({ ...emptyManifest('p', 'p-identity', 'large', 'c'), seeded: [tenant('S1')], transient: ['T1'] });
    const r = await sweepTenants(store, false, { deleteOne: async () => true, readStatus: async () => 404 });
    expect(r).toMatchObject({ ids: ['T1'], failed: 0, left: 0 });
    expect(store.seeded.map((t) => t.tenantId)).toEqual(['S1']);
    expect(store.transient).toEqual([]);
  });
});

describe('collect arithmetic', () => {
  const doc = (start: string, end: string, requests: Record<string, number>) => ({ window: { start, end }, requests, refusals: { unattributed: 0 } });
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };
  const docs = [
    doc('2026-11-19T10:00:20Z', '2026-11-19T10:02:10Z', { '200': 90, '503:dependency-throttled': 4, '0:network': 3 }),
    doc('2026-11-19T10:02:15Z', '2026-11-19T10:03:40Z', { '201': 10, '404:not-found': 2 }),
  ];

  const iso = (ws: { start: Date; end: Date }[]) => ws.map((w) => [w.start.toISOString(), w.end.toISOString()]);

  test('windows that share a minute merge into one, in whole minutes', () => {
    expect(iso(windowsOf(docs))).toEqual([['2026-11-19T10:00:00.000Z', '2026-11-19T10:04:00.000Z']]);
    expect(driverCounts(docs)).toEqual({ reached: 106, seen5xx: 4 });
  });

  test('a gap between scenarios stays out of the windows', () => {
    const gapped = [docs[0], doc('2026-11-19T10:09:05Z', '2026-11-19T10:10:00Z', {})];
    expect(iso(windowsOf(gapped))).toEqual([
      ['2026-11-19T10:00:00.000Z', '2026-11-19T10:03:00.000Z'],
      ['2026-11-19T10:09:00.000Z', '2026-11-19T10:10:00.000Z'],
    ]);
  });

  test('seed 5xx count only inside a window', () => {
    const [w] = windowsOf(docs);
    expect(seed5xxIn({ '2026-11-19T09:59:00.000Z': 7, '2026-11-19T10:00:00.000Z': 2, '2026-11-19T10:04:00.000Z': 5 }, w.start, w.end)).toBe(2);
    expect(seed5xxIn(undefined, w.start, w.end)).toBe(0);
  });

  test("another slice's 5XX in the gap between scenarios is not charged here", async () => {
    const gapped = [doc('2026-11-19T10:00:20Z', '2026-11-19T10:01:40Z', { 200: 10 }), doc('2026-11-19T10:06:10Z', '2026-11-19T10:06:50Z', { 200: 10 })];
    // 5XX per minute as API Gateway would report it: 9 in 10:03, inside the gap.
    const fiveXx: Record<string, number> = { '2026-11-19T10:03:00.000Z': 9 };
    const perMinute = (metric: string, start: Date, end: Date) => {
      let n = 0;
      for (let t = start.getTime(); t < end.getTime(); t += MINUTE) {
        n += metric === 'Count' ? 10 : fiveXx[new Date(t).toISOString()] ?? 0;
      }
      return n;
    };
    const apiSum = jest.fn(async (metric: 'Count' | '5XXError', start: Date, end: Date) => perMinute(metric, start, end));
    const c = await collectFiveXx(gapped, undefined, { ...clock(), apiSum });
    expect(c).toMatchObject({ caughtUp: true, api5xx: 0, extra: 0 });
    expect(c.windows).toHaveLength(2);
    // One call per window and metric, never one over 10:00..10:07; Count reads one minute past the window.
    expect(apiSum.mock.calls.every(([m, s, e]) => e.getTime() - s.getTime() <= (m === 'Count' ? 3 : 2) * MINUTE)).toBe(true);
  });

  test('Count is read one minute past the window, 5XXError exactly on it', async () => {
    const apiSum = jest.fn(async (metric: 'Count' | '5XXError') => (metric === 'Count' ? 100 : 4));
    const c = await collectFiveXx(docs, undefined, { ...clock(), apiSum });
    const [w] = c.windows;
    expect(apiSum).toHaveBeenCalledWith('Count', w.start, new Date(w.end.getTime() + MINUTE));
    expect(apiSum).toHaveBeenCalledWith('5XXError', w.start, w.end);
  });

  test('seed 5xx in a shared minute are not unattributed refusals', async () => {
    const c = await collectFiveXx(docs, { '2026-11-19T10:00:00.000Z': 3 }, {
      ...clock(),
      apiSum: async (metric) => (metric === 'Count' ? 120 : 7),
    });
    expect(c).toMatchObject({ caughtUp: true, seen5xx: 4, seed5xx: 3, extra: 0 });
  });

  test('a 5XX nobody saw is extra', async () => {
    const c = await collectFiveXx(docs, undefined, { ...clock(), apiSum: async (metric) => (metric === 'Count' ? 106 : 6) });
    expect(c).toMatchObject({ caughtUp: true, extra: 2 });
  });

  test('waits for Count, then reports caught up', async () => {
    const counts = [10, 50, 100];
    const c = await collectFiveXx(docs, undefined, { ...clock(), apiSum: async (metric) => (metric === 'Count' ? counts.shift() ?? 100 : 4) });
    expect(c).toMatchObject({ caughtUp: true, counted: 100, extra: 0 });
  });

  test('metrics that never catch up are not caught up, even with no 5XX', async () => {
    const k = clock();
    const apiSum = jest.fn(async (metric: string) => (metric === 'Count' ? 20 : 0));
    const c = await collectFiveXx(docs, undefined, { ...k, apiSum });
    expect(c).toMatchObject({ caughtUp: false, extra: 0 });
    expect(k.now()).toBeGreaterThanOrEqual(4 * MINUTE);
  });

  test('the leftover goes on the record that ends last', () => {
    const d = [{ file: 'a', doc: docs[1] }, { file: 'b', doc: docs[0] }];
    expect(latestOf(d).file).toBe('a');
  });
});
