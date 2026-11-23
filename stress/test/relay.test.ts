// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REASONS, RELAY_SLICE } from '../dashboard/widgets';
import { minuteLine, newStat } from '../k6/minute';
import { METRICS } from '../src/metrics';

const RELAY = path.resolve(__dirname, '..', 'k6', 'relay.sh');
const RUN = '20261123T1200Z';
const M1 = 29_920_866;
const M2 = M1 + 1;
/** Minutes that have not ended, so the grace never applies to them. */
const FUTURE = Math.floor(Date.now() / 60_000) + 1000;

/** One line of k6's output for a console.log of `obj`, as k6 writes it. */
const k6Line = (obj: unknown, at = '2026-11-23T12:00:00Z'): string => `time="${at}" level=info msg=${JSON.stringify(JSON.stringify(obj))} source=console`;

/** A minute line, built by the k6 library's own module, so a renamed key breaks these tests. */
function minute(epochMinute: number, vu: number, counts: Record<string, number> = {}, hist: Record<string, number> = {}): unknown {
  const stat = Object.assign(newStat(epochMinute, 0), counts) as ReturnType<typeof newStat>;
  Object.assign(stat.hist, hist);
  return minuteLine(stat, vu);
}

interface Call {
  readonly MetricName: string;
  readonly Dimensions: { Name: string; Value: string }[];
  readonly Timestamp: string;
  readonly Value?: number;
  readonly Values?: number[];
  readonly Counts?: number[];
  readonly Unit: string;
}

/** A folder with the stub `aws`, the output file and the relay's state, kept between runs of the relay. */
function bench(lines: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const file = path.join(dir, 'k6-stdout.txt');
  const capture = path.join(dir, 'calls');
  const failOnce = path.join(dir, 'fail-once');
  const failAlways = path.join(dir, 'fail-always');
  const attempts = path.join(dir, 'attempts');
  fs.mkdirSync(capture);
  fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  const stub = path.join(dir, 'aws');
  fs.writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'if [ -e "$FAIL_ONCE" ]; then rm -f "$FAIL_ONCE"; echo "Throttling: rate exceeded" >&2; exit 254; fi',
      'if [ -e "$FAIL_ALWAYS" ]; then echo x >> "$ATTEMPTS"; echo "Throttling: rate exceeded" >&2; exit 254; fi',
      'n=$(ls "$CAPTURE" | wc -l)',
      'f="${!#}"',
      'cp "${f#file://}" "$CAPTURE/call-$(printf %03d "$n").json"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    dir,
    file,
    failOnce,
    failAlways,
    attempts: (): number => (fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').split('\n').filter(Boolean).length : 0),
    append: (more: string[]) => fs.appendFileSync(file, `${more.join('\n')}\n`),
    run(env: Record<string, string> = {}) {
      const r = spawnSync('bash', [RELAY], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          STRESS_RUN_ID: RUN,
          RECORD_SCENARIO: 'PS-3',
          AWS_REGION: 'eu-central-1',
          RELAY_FILE: file,
          RELAY_AWS: stub,
          RELAY_STATE_DIR: path.join(dir, 'state'),
          RELAY_ONCE: '1',
          CAPTURE: capture,
          FAIL_ONCE: failOnce,
          FAIL_ALWAYS: failAlways,
          ATTEMPTS: attempts,
          ...env,
        },
      });
      return { status: r.status, out: r.stdout, err: r.stderr };
    },
    calls: (): Call[][] => fs.readdirSync(capture).sort().map((f) => JSON.parse(fs.readFileSync(path.join(capture, f), 'utf8')) as Call[]),
  };
}

const named = (c: Call[], name: string): Call[] => c.filter((d) => d.MetricName === name);
const dim = (d: Call, n: string): string | undefined => d.Dimensions.find((x) => x.Name === n)?.Value;
const total = (c: Call[], name: string): number => named(c, name).reduce((a, d) => a + (d.Value ?? 0), 0);

describe('the host relay (stress/k6/relay.sh, design §5)', () => {
  const lines = [
    k6Line({ kind: 'noisy_tenant', tenantId: 'T0' }),
    k6Line(minute(M1, 1, { s2xx: 8, s4xx: 2, assertions: 10, refusals: 2 }, { 40: 5, 41: 5 })),
    k6Line(minute(M1, 2, { s2xx: 7, s4xx: 1, s5xx: 1, assertions: 9, mismatches: 1, refusals: 2 }, { 40: 3, 52: 6 })),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T1', status: 429 }),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T1', status: 429, count: 2 }),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T2', status: 418 }),
    k6Line({ kind: 'body_refusal', epochMinute: M1, tenantId: 'T3', reason: 'Tool-403' }),
    k6Line(minute(M2, 1, { s2xx: 4, assertions: 4 }, { 40: 4 })),
    'running (0m26.0s), 10/10 VUs, 0 complete and 0 interrupted iterations',
  ];

  it('publishes a finished minute the way the StressRun contract names it, and nothing the contract does not', () => {
    const b = bench(lines);
    const r = b.run();
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    expect(b.calls().length).toBe(2);
    for (const call of b.calls()) {
      for (const d of call) {
        const spec = METRICS[d.MetricName as keyof typeof METRICS];
        expect(spec).toBeDefined();
        expect(d.Unit).toBe(spec.unit);
        expect(d.Dimensions.map((x) => x.Name).sort()).toEqual([...spec.dimensions].sort());
        expect(dim(d, 'RunId')).toBe(RUN);
        expect(d.Timestamp).toMatch(/^2026-11-\d\dT\d\d:\d\d:00Z$/);
      }
      expect(call.some((d) => /tenant|user|token/i.test(JSON.stringify(d.Dimensions)))).toBe(false);
    }
    expect(b.calls()[0]![0]!.Timestamp).toBe(new Date(M1 * 60_000).toISOString().replace('.000Z', 'Z'));
  });

  it('sums the VUs of a minute: requests by class, assertions, mismatches, refusals seen and named', () => {
    const b = bench(lines);
    b.run();
    const call = b.calls()[0]!;
    expect(total(call, 'IsolationAssertions')).toBe(19);
    expect(total(call, 'IsolationMismatches')).toBe(1);
    expect(dim(named(call, 'IsolationAssertions')[0]!, 'Slice')).toBe(RELAY_SLICE);
    expect(total(call, 'RefusalsSeen')).toBe(4);
    expect(total(call, 'RefusalsNamed')).toBe(5);
    const byClass = Object.fromEntries(named(call, 'Requests').map((d) => [dim(d, 'StatusClass'), d.Value]));
    expect(byClass).toEqual({ '2xx': 15, '4xx': 3, '5xx': 1 });
  });

  it('counts refusals by reason, folding an unlisted reason into other', () => {
    const b = bench(lines);
    b.run();
    const byReason = Object.fromEntries(named(b.calls()[0]!, 'RefusalsByReason').map((d) => [dim(d, 'Reason'), d.Value]));
    expect(byReason).toEqual({ 'http-429': 3, 'other': 2 });
  });

  it('publishes the latency of a minute as a histogram, merged over the VUs, at most 150 buckets', () => {
    const b = bench(lines);
    b.run();
    const h = named(b.calls()[0]!, 'ClientLatencyMs')[0]!;
    expect(h.Counts).toEqual([8, 5, 6]);
    expect(h.Values!.length).toBe(h.Counts!.length);
    expect(h.Values!.length).toBeLessThanOrEqual(150);
    expect(h.Values![0]).toBeCloseTo(1.12 ** 40, 2);
    expect(h.Values).toEqual([...h.Values!].sort((a, c) => a - c));
  });

  it('keeps the dashboard\'s reason list, its slice name and the relay\'s the same', () => {
    const text = fs.readFileSync(RELAY, 'utf8');
    const listed = /RELAY_REASONS:-([^}]+)\}/.exec(text)![1]!.split(' ');
    expect(listed).toEqual(REASONS.filter((r) => r !== 'other'));
    expect(/RELAY_SLICE:-([^}]+)\}/.exec(text)![1]).toBe(RELAY_SLICE);
  });

  it('on an ordinary pass publishes a minute every VU has finished and holds one that is still open', () => {
    const b = bench([
      k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 })),
      k6Line(minute(FUTURE, 2, { s2xx: 1, assertions: 1 })),
      k6Line(minute(FUTURE + 1, 1, { s2xx: 1, assertions: 1 })),
    ]);
    b.run({ RELAY_ONCE: 'pass' });
    expect(b.calls().length).toBe(1);
    expect(total(b.calls()[0]!, 'IsolationAssertions')).toBe(2);
    // One VU alone, no later minute, before its grace: nothing goes.
    const alone = bench([k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 }))]);
    alone.run({ RELAY_ONCE: 'pass' });
    expect(alone.calls()).toEqual([]);
    // The same minute goes on the last pass.
    const last = bench([k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 }))]);
    last.run();
    expect(last.calls().length).toBe(1);
  });

  it('publishes an old minute after its grace even when a VU has not printed a line for it', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 })), k6Line(minute(M2, 2, { s2xx: 1, assertions: 1 }))]);
    b.run({ RELAY_ONCE: 'pass' });
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([1, 1]);
  });

  it('publishes a line that arrives after its minute went out as an addition, once', () => {
    const b = bench([
      k6Line(minute(FUTURE, 1, { s2xx: 5, assertions: 5 }, { 40: 5 })),
      k6Line(minute(FUTURE, 2, { s2xx: 5, assertions: 5 }, { 40: 5 })),
      k6Line(minute(FUTURE + 1, 1, { s2xx: 1, assertions: 1 })),
    ]);
    b.run({ RELAY_ONCE: 'pass' });
    expect(b.calls().length).toBe(1);
    // A VU's line for the minute that has been published, and a refusal line for it, arrive late.
    b.append([k6Line(minute(FUTURE, 1, { s4xx: 3, assertions: 3, refusals: 3 }, { 41: 3 })), k6Line({ kind: 'edge_refusal', epochMinute: FUTURE, tenantId: 'T', status: 403, count: 3 })]);
    b.run({ RELAY_ONCE: 'pass' });
    const calls = b.calls();
    expect(calls.length).toBe(2);
    const late = calls[1]!;
    expect(total(late, 'IsolationAssertions')).toBe(3);
    expect(total(late, 'RefusalsSeen')).toBe(3);
    expect(total(late, 'RefusalsNamed')).toBe(3);
    expect(named(late, 'Requests').map((d) => [dim(d, 'StatusClass'), d.Value])).toEqual([['4xx', 3]]);
    expect(named(late, 'RefusalsByReason').map((d) => [dim(d, 'Reason'), d.Value])).toEqual([['http-403', 3]]);
    expect(named(late, 'ClientLatencyMs')[0]!.Counts).toEqual([3]);
    // Nothing more arrived: a third pass publishes nothing, and the first publication is not repeated.
    b.run({ RELAY_ONCE: 'pass' });
    expect(b.calls().length).toBe(2);
    // Over all calls the minute holds what was printed, no more and no less.
    expect(b.calls().reduce((a, c) => a + total(c, 'IsolationAssertions'), 0)).toBe(13);
  });

  it('reads only the lines that are new at each pass', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 2, assertions: 2 }))]);
    b.run();
    expect(b.calls().length).toBe(1);
    b.run();
    expect(b.calls().length).toBe(1);
    b.append([k6Line(minute(M2, 1, { s2xx: 3, assertions: 3 }))]);
    b.run();
    expect(b.calls().length).toBe(2);
    expect(total(b.calls()[1]!, 'IsolationAssertions')).toBe(3);
  });

  it('stops on the stop file with a final pass, and ends itself when its time is up', () => {
    const b = bench([k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 }))]);
    fs.writeFileSync(path.join(b.dir, 'stop'), '');
    expect(b.run({ RELAY_ONCE: '', RELAY_STOP_FILE: path.join(b.dir, 'stop'), RELAY_POLL_S: '1' }).status).toBe(0);
    expect(b.calls().length).toBe(1);
    const orphan = bench([k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 }))]);
    expect(orphan.run({ RELAY_ONCE: '', RELAY_MAX_S: '0', RELAY_POLL_S: '1', RELAY_STOP_FILE: path.join(orphan.dir, 'never') }).status).toBe(0);
    expect(orphan.calls().length).toBe(1);
  });

  it('keeps a failed minute for the next pass and publishes it then, once', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 }))]);
    fs.writeFileSync(b.failOnce, '');
    const first = b.run();
    expect(first.status).toBe(0);
    expect(first.err).toContain('put-metric-data failed for minute');
    expect(first.err).toContain('Throttling');
    expect(b.calls()).toEqual([]);
    expect(b.run().status).toBe(0);
    expect(b.calls().length).toBe(1);
    expect(total(b.calls()[0]!, 'IsolationAssertions')).toBe(1);
    b.run();
    expect(b.calls().length).toBe(1);
  });

  it('gives up a pass after the first failed call, with two minutes pending, and publishes both on the next', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 })), k6Line(minute(M2, 1, { s2xx: 2, assertions: 2 }))]);
    fs.writeFileSync(b.failAlways, '');
    const first = b.run({ RELAY_ONCE: 'pass' });
    expect(first.status).toBe(0);
    expect(b.attempts()).toBe(1);
    expect(b.calls()).toEqual([]);
    fs.rmSync(b.failAlways);
    b.run({ RELAY_ONCE: 'pass' });
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([1, 2]);
  });

  it('on the last pass tries each pending minute even when one call failed', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 })), k6Line(minute(M2, 1, { s2xx: 2, assertions: 2 }))]);
    fs.writeFileSync(b.failOnce, '');
    const r = b.run();
    expect(r.err).toContain('put-metric-data failed for minute');
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([2]);
  });

  it('reads a file that is shorter than the lines it has read from its first line', () => {
    const b = bench([1, 2, 3, 4, 5].map((n) => k6Line(minute(M1 + n, 1, { s2xx: 1, assertions: 1 }))));
    b.run();
    expect(b.calls().length).toBe(5);
    fs.writeFileSync(b.file, `${[k6Line(minute(M1 + 20, 1, { s2xx: 4, assertions: 4 })), k6Line(minute(M1 + 21, 1, { s2xx: 5, assertions: 5 }))].join('\n')}\n`);
    b.run();
    expect(b.calls().slice(5).map((c) => total(c, 'IsolationAssertions'))).toEqual([4, 5]);
  });

  it('refuses a parent process id that is not a number', () => {
    expect(bench([]).run({ RELAY_PARENT_PID: 'abc' }).status).toBe(2);
    expect(bench([]).run({ RELAY_PARENT_PID: '0' }).status).toBe(2);
  });

  it('does not read a last line that is not finished, and counts it once when it is', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 }))]);
    const whole = k6Line(minute(M2, 1, { s2xx: 2, assertions: 2 }));
    fs.appendFileSync(b.file, whole.slice(0, 40));
    b.run();
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([1]);
    fs.appendFileSync(b.file, `${whole.slice(40)}\n`);
    b.run();
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([1, 2]);
  });

  it('starts its state again, with a message, when the state file cannot be read, and goes on', () => {
    const b = bench([k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 }))]);
    fs.mkdirSync(path.join(b.dir, 'state'));
    fs.writeFileSync(path.join(b.dir, 'state', 'state.json'), '{not json');
    const first = b.run();
    expect(first.status).toBe(0);
    expect(first.err).toContain('skipping to line');
    expect(first.err).toContain('state file was not readable');
    expect(b.calls()).toEqual([]);
    b.append([k6Line(minute(M2, 1, { s2xx: 2, assertions: 2 }))]);
    b.run();
    expect(b.calls().map((c) => total(c, 'IsolationAssertions'))).toEqual([2]);
  });

  it('makes a last pass and ends when its parent process is gone', () => {
    const dead = spawnSync('true').pid!;
    const b = bench([k6Line(minute(FUTURE, 1, { s2xx: 1, assertions: 1 }))]);
    const r = b.run({ RELAY_ONCE: '', RELAY_PARENT_PID: String(dead), RELAY_POLL_S: '1', RELAY_STOP_FILE: path.join(b.dir, 'never') });
    expect(r.status).toBe(0);
    expect(b.calls().length).toBe(1);
  });

  it('survives lines it cannot use: a minute out of range, a histogram key that is no bucket, a line with no VU', () => {
    const bad = [
      k6Line({ ...(minute(M1, 1, { s2xx: 1 }) as object), epochMinute: 1e20 }),
      k6Line({ ...(minute(M1, 1, { s2xx: 1 }) as object), epochMinute: 'soon' }),
      k6Line({ ...(minute(M1, 1, { s2xx: 1 }) as object), vu: 'x' }),
      k6Line({ ...(minute(M1, 1, { s2xx: 1, assertions: 1 }) as object), hist: { 'NaN': 4, '-3': 1, '9999': 1, '40': 2 } }),
      '{"kind":"minute"',
      'time="x" level=info msg="not json" source=console',
    ];
    const b = bench(bad);
    const r = b.run();
    expect(r.status).toBe(0);
    const call = b.calls()[0]!;
    expect(total(call, 'IsolationAssertions')).toBe(1);
    expect(named(call, 'ClientLatencyMs')[0]!.Counts).toEqual([2]);
  });

  it('reads a refusal reason that holds a quote or a backslash, and counts it', () => {
    const b = bench([
      k6Line(minute(M1, 1, { s4xx: 1, assertions: 1, refusals: 2 })),
      k6Line({ kind: 'body_refusal', epochMinute: M1, tenantId: 'T', reason: 'bad "x" \\ y' }),
      k6Line({ kind: 'body_refusal', epochMinute: M1, tenantId: 'T', reason: 'tool-403' }),
    ]);
    b.run();
    expect(total(b.calls()[0]!, 'RefusalsNamed')).toBe(2);
  });

  it('refuses a run id or scenario that is not one, and a file that is missing is no error', () => {
    expect(bench([]).run({ STRESS_RUN_ID: 'a b' }).status).toBe(2);
    expect(bench([]).run({ RECORD_SCENARIO: 'PS 2; rm' }).status).toBe(2);
    expect(bench([]).run({ RELAY_FILE: '/nonexistent/k6.txt' }).status).toBe(0);
  });
});
