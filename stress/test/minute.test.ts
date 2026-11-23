// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { bump, COUNT_KEYS, LATENCY_MAX_BUCKET, latencyBucket, minuteLine, newStat, newVuState, statusClass } from '../k6/minute';

interface Stat {
  s2xx: number;
  refusals: number;
  hist: Record<string, number>;
  [key: string]: unknown;
}
const fresh = (minute: number, nowMs?: number): Stat => newStat(minute, nowMs) as unknown as Stat;

describe('the k6 minute line (stress/k6/minute.js, read by relay.sh)', () => {
  it('names the status class of a response, and none for no answer or an unusual status', () => {
    expect(statusClass(200)).toBe('s2xx');
    expect(statusClass(204)).toBe('s2xx');
    expect(statusClass(301)).toBe('s3xx');
    expect(statusClass(429)).toBe('s4xx');
    expect(statusClass(503)).toBe('s5xx');
    for (const odd of [0, 100, 199, 600, -1, NaN, undefined]) expect(statusClass(odd as number)).toBe('snone');
  });

  it('puts a latency in a log-spaced bucket, 12 % wide, between 1 ms and 120 s', () => {
    expect(latencyBucket(1)).toBe(0);
    expect(latencyBucket(0.2)).toBe(0);
    expect(latencyBucket(Number.NaN)).toBe(0);
    expect(latencyBucket(-5)).toBe(0);
    expect(latencyBucket(1.12 ** 40 - 0.001)).toBe(40);
    expect(latencyBucket(1.12 ** 40 + 0.001)).toBe(41);
    expect(latencyBucket(120_000)).toBe(LATENCY_MAX_BUCKET);
    expect(latencyBucket(10_000_000)).toBe(LATENCY_MAX_BUCKET);
    expect(LATENCY_MAX_BUCKET).toBeLessThan(150);
    for (let ms = 1; ms < 120_000; ms *= 1.37) {
      const upper = 1.12 ** latencyBucket(ms);
      expect(upper).toBeGreaterThanOrEqual(ms - 1e-9);
      expect(upper / ms).toBeLessThan(1.1201);
    }
  });

  it('prints counts only, under the keys the relay sums', () => {
    const stat = fresh(29_924_046, 1_000);
    stat.s2xx = 7;
    stat.refusals = 2;
    stat.hist['41'] = 3;
    const line = minuteLine(stat as never, 3);
    expect(line).toEqual({
      kind: 'minute', epochMinute: 29_924_046, vu: 3, s2xx: 7, s3xx: 0, s4xx: 0, s5xx: 0, snone: 0, assertions: 0, mismatches: 0, refusals: 2, hist: { 41: 3 },
    });
    expect(Object.keys(line).filter((k) => !['kind', 'epochMinute', 'vu', 'hist'].includes(k))).toEqual(COUNT_KEYS);
    expect(JSON.stringify(line)).not.toMatch(/tenant|token|since/i);
  });

  describe('when a VU prints (bump)', () => {
    const MIN = 60_000;
    const run = (calls: Array<{ at: number; progress?: number; iteration?: number }>) => {
      const state = newVuState();
      const printed: Array<{ epochMinute: number; s2xx: number }> = [];
      let applied = 0;
      calls.forEach((call, i) => {
        bump(state, call.at, call.progress ?? 0, (s: Stat) => {
          s.s2xx += 1;
          applied += 1;
        }, (s: Stat) => printed.push({ epochMinute: s.minute as number, s2xx: s.s2xx }), call.iteration ?? i);
      });
      const pending = (state.stat as Stat | null)?.s2xx ?? 0;
      return { printed, applied, pending };
    };

    it('prints every LINE_EVERY_MS inside a minute and holds the rest', () => {
      const base = 1000 * MIN;
      const out = run([0, 1000, 2000, 4999, 5000, 5100, 6000].map((d) => ({ at: base + d })));
      expect(out.printed).toEqual([{ epochMinute: 1000, s2xx: 5 }]);
      expect(out.pending).toBe(2);
    });

    it('moves a count at a minute boundary to the new minute, not both', () => {
      const base = 1000 * MIN;
      const out = run([{ at: base + MIN - 2000 }, { at: base + MIN - 1 }, { at: base + MIN }, { at: base + MIN + 10 }]);
      expect(out.printed).toEqual([{ epochMinute: 1000, s2xx: 2 }]);
      expect(out.pending).toBe(2);
    });

    it('prints once a second in the last 5 % when each call is its own iteration, and holds under a second of calls', () => {
      const base = 1000 * MIN;
      // 40 calls 100 ms apart: prints at the first call and every 1,000 ms after it: calls 0, 10, 20, 30.
      const calls = Array.from({ length: 40 }, (_, i) => ({ at: base + 10_000 + i * 100, progress: 0.96, iteration: i }));
      const out = run(calls);
      expect(out.printed.length).toBe(4);
      expect(out.pending).toBe(9);
    });

    it('prints the calls of one iteration together in the last 5 %, so a request is never split', () => {
      const base = 1000 * MIN;
      const calls = [
        { at: base + 10_000, progress: 0.96, iteration: 7 },
        { at: base + 10_050, progress: 0.96, iteration: 7 },
        { at: base + 10_100, progress: 0.96, iteration: 7 },
        { at: base + 10_500, progress: 0.96, iteration: 8 },
      ];
      const out = run(calls);
      expect(out.printed.reduce((n, l) => n + l.s2xx, 0)).toBe(3);
      expect(out.pending).toBe(1);
    });

    /**
     * `rps` requests a second handed out round robin to `vus` VUs for `seconds`; each request makes three
     * counts (status, timing, assertion) in its own iteration. Returns what was printed, by count.
     */
    const simulate = (vus: number, seconds: number, startOffsetMs = 0, rps = 16, gapMs = 0) => {
      const base = 1000 * MIN + startOffsetMs;
      const states = Array.from({ length: vus }, () => newVuState());
      const printed = { status: 0, assertion: 0, timing: 0 };
      let requests = 0;
      const apply = (key: 'status' | 'assertion' | 'timing') => (s: Stat) => {
        s[key] = ((s[key] as number | undefined) ?? 0) + 1;
      };
      const count = (s: Stat) => {
        for (const k of ['status', 'assertion', 'timing'] as const) printed[k] += (s[k] as number | undefined) ?? 0;
      };
      for (let n = 0; n < seconds * rps; n += 1) {
        const at = base + Math.floor((n * 1000) / rps);
        const progress = (at - base) / (seconds * 1000);
        (['status', 'timing', 'assertion'] as const).forEach((k, i) => bump(states[n % vus]!, at + 1 + i * gapMs, progress, apply(k), count, Math.floor(n / vus)));
        requests += 1;
      }
      return { printed, requests };
    };

    it('loses no request over 50 VUs, 16 requests a second, 4 minutes (the SD-2 load)', () => {
      const { printed, requests } = simulate(50, 240);
      expect(printed).toEqual({ status: requests, assertion: requests, timing: requests });
    });

    it('never splits a request: the three counts print equal, for VUs that are idle in the whole last 5 % too', () => {
      for (const [vus, seconds, offset] of [[100, 60, 0], [100, 60, 7000], [100, 240, 0], [50, 60, 3000]] as const) {
        const { printed, requests } = simulate(vus, seconds, offset);
        expect(printed.assertion).toBe(printed.status);
        expect(printed.timing).toBe(printed.status);
        // what is lost is whole requests, and fewer than a tenth of them
        expect(printed.status).toBeLessThanOrEqual(requests);
        expect(printed.status).toBeGreaterThan(requests * 0.9);
      }
    });

    it('never splits a request whose counts are a few milliseconds or seconds apart, over a 5 s or a minute edge', () => {
      for (const gap of [3, 400, 2500]) {
        for (const offset of [0, 1_900, 4_000, 58_000]) {
          const { printed } = simulate(100, 60, offset, 16, gap);
          expect(printed.assertion).toBe(printed.status);
          expect(printed.timing).toBe(printed.status);
        }
      }
    });

    it('keeps a request whole across a minute edge: its three counts stay in the minute of the first one', () => {
      const state = newVuState();
      const printed: Array<{ minute: number; status: number; timing: number; assertion: number }> = [];
      const of = (s: Stat, key: string): number => (s[key] as number | undefined) ?? 0;
      const record = (s: Stat) => printed.push({ minute: s.minute as number, status: of(s, 'status'), timing: of(s, 'timing'), assertion: of(s, 'assertion') });
      const count = (key: string) => (s: Stat) => {
        s[key] = ((s[key] as number | undefined) ?? 0) + 1;
      };
      const edge = 1001 * MIN;
      bump(state, edge - 1, 0, count('status'), record, 5);
      bump(state, edge + 1, 0, count('timing'), record, 5);
      bump(state, edge + 2, 0, count('assertion'), record, 5);
      expect(printed).toEqual([]);
      expect((state.stat as unknown as Stat).minute).toBe(1000);
      expect(state.stat).toMatchObject({ status: 1, timing: 1, assertion: 1 });
      // the next iteration moves to the new minute and prints the old one whole
      bump(state, edge + 3000, 0, count('status'), record, 6);
      expect(printed).toEqual([{ minute: 1000, status: 1, timing: 1, assertion: 1 }]);
    });

    it('keeps a request in the minute of its first count when a print begins at that count', () => {
      const state = newVuState();
      const printed: Array<{ minute: number; status: number; timing: number; assertion: number }> = [];
      const of = (s: Stat, key: string): number => (s[key] as number | undefined) ?? 0;
      const record = (s: Stat) => printed.push({ minute: s.minute as number, status: of(s, 'status'), timing: of(s, 'timing'), assertion: of(s, 'assertion') });
      const count = (key: string) => (s: Stat) => {
        s[key] = ((s[key] as number | undefined) ?? 0) + 1;
      };
      const edge = 1001 * MIN;
      // iteration 1 holds a count for 20 s, so the first count of iteration 2 finds the stat older than 5 s and prints
      // it at once; the other two counts of iteration 2 come after the minute edge
      bump(state, edge - 20_000, 0, count('status'), record, 1);
      bump(state, edge - 20, 0, count('status'), record, 2);
      bump(state, edge + 10, 0, count('timing'), record, 2);
      bump(state, edge + 15, 0, count('assertion'), record, 2);
      const lines = printed.filter((p) => p.status + p.timing + p.assertion > 0);
      expect(lines.map((p) => p.minute)).toEqual([1000, 1000, 1000]);
      expect(lines.reduce((n, p) => n + p.status, 0)).toBe(2);
      expect(lines.reduce((n, p) => n + p.timing, 0)).toBe(1);
      expect(lines.reduce((n, p) => n + p.assertion, 0)).toBe(1);
    });

    it('counts the first iteration of a second scenario in its own minute, not in the minute of the last iteration before', () => {
      const state = newVuState();
      const printed: number[] = [];
      const record = (s: Stat) => printed.push(s.minute as number);
      const count = (s: Stat) => {
        s.s2xx += 1;
      };
      // the warm-up's only iteration is 0 and its stat is held; the timed scenario starts at iteration 0 ten minutes later
      bump(state, 1000 * MIN + 100, 0, count, record, 0, 'warm-up');
      bump(state, 1010 * MIN + 100, 0, count, record, 0, 'timed');
      expect(printed).toEqual([1000]);
      expect((state.stat as unknown as Stat).minute).toBe(1010);
    });

    it('prints every call when the iteration is not known, and so loses nothing in a split request', () => {
      const state = newVuState();
      const printed: number[] = [];
      for (let i = 0; i < 5; i += 1) bump(state, 1000 * MIN + i, 0, (s: Stat) => { s.s2xx += 1; }, (s: Stat) => printed.push(s.s2xx), undefined);
      expect(printed).toEqual([1, 1, 1, 1, 1]);
    });

    it('does not hold the first request of a new minute in the last 5 % because the old minute printed at the change', () => {
      const state = newVuState();
      const printed: number[] = [];
      const call = (at: number, iteration: number) =>
        bump(state, at, 0.97, (s: Stat) => { s.s2xx += 1; }, (s: Stat) => printed.push(s.s2xx), iteration);
      call(1000 * MIN + 50_000, 1);
      call(1000 * MIN + 50_500, 2);
      call(1001 * MIN + 100, 3);
      expect(printed).toEqual([1, 1, 1]);
      expect(state.stat).toBeNull();
    });

    it('prints exactly what it applied: printed plus pending equals applied, over several minutes', () => {
      const base = 1000 * MIN;
      const calls: Array<{ at: number; progress?: number; iteration?: number }> = [];
      for (let i = 0; i < 2000; i += 1) calls.push({ at: base + i * 137, progress: i > 1800 ? 0.97 : i / 2000, iteration: i });
      const out = run(calls);
      const printedSum = out.printed.reduce((n, l) => n + l.s2xx, 0);
      expect(printedSum + out.pending).toBe(out.applied);
      expect(new Set(out.printed.map((l) => l.epochMinute)).size).toBeGreaterThan(3);
    });
  });

  it('starts every minute empty', () => {
    const a = fresh(1);
    a.hist['3'] = 1;
    expect(fresh(2).hist).toEqual({});
    for (const key of COUNT_KEYS) expect(fresh(2)[key]).toBe(0);
  });
});
