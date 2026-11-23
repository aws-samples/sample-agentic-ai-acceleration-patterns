// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REASONS } from '../dashboard/widgets';
import { METRICS } from '../src/metrics';

const RELAY = path.resolve(__dirname, '..', 'k6', 'relay.sh');
const RUN = '20261123T1200Z';
const M1 = 29_920_866;
const M2 = M1 + 1;

/** One line of k6's output for a console.log of `obj`, as k6 writes it. */
const k6Line = (obj: unknown, at = '2026-11-23T12:00:00Z'): string => `time="${at}" level=info msg=${JSON.stringify(JSON.stringify(obj))} source=console`;

const minute = (epochMinute: number, vu: number, extra: Record<string, unknown>): unknown => ({
  kind: 'minute', epochMinute, vu, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, snone: 0, assertions: 0, mismatches: 0, refusals: 0, hist: {}, ...extra,
});

interface Call {
  readonly MetricName: string;
  readonly Dimensions: { Name: string; Value: string }[];
  readonly Timestamp: string;
  readonly Value?: number;
  readonly Values?: number[];
  readonly Counts?: number[];
  readonly Unit: string;
}

/** Runs the relay once over `lines`, with a stub for the AWS CLI; returns what it published, by call. */
function relay(lines: string[], env: Record<string, string> = {}): { calls: Call[][]; status: number | null; out: string; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const file = path.join(dir, 'k6-stdout.txt');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const stub = path.join(dir, 'aws');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\nn=$(ls "$CAPTURE" | wc -l)\nf="${!#}"\ncp "${f#file://}" "$CAPTURE/call-$n.json"\n', { mode: 0o755 });
  const capture = path.join(dir, 'calls');
  fs.mkdirSync(capture);
  const r = spawnSync('bash', [RELAY], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, STRESS_RUN_ID: RUN, RECORD_SCENARIO: 'PS-3', AWS_REGION: 'eu-central-1', RELAY_FILE: file, RELAY_AWS: stub, RELAY_ONCE: '1', CAPTURE: capture, ...env },
  });
  const calls = fs.readdirSync(capture).sort().map((f) => JSON.parse(fs.readFileSync(path.join(capture, f), 'utf8')) as Call[]);
  return { calls, status: r.status, out: r.stdout, err: r.stderr };
}

const named = (c: Call[], name: string): Call[] => c.filter((d) => d.MetricName === name);
const dim = (d: Call, n: string): string | undefined => d.Dimensions.find((x) => x.Name === n)?.Value;

describe('the host relay (stress/k6/relay.sh, design §5)', () => {
  const lines = [
    k6Line({ kind: 'noisy_tenant', tenantId: 'T0' }),
    k6Line(minute(M1, 1, { s2xx: 8, s4xx: 2, assertions: 10, refusals: 2, hist: { 40: 5, 41: 5 } })),
    k6Line(minute(M1, 2, { s2xx: 7, s4xx: 1, s5xx: 1, assertions: 9, mismatches: 1, refusals: 2, hist: { 40: 3, 52: 6 } })),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T1', status: 429 }),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T1', status: 429, count: 2 }),
    k6Line({ kind: 'edge_refusal', epochMinute: M1, tenantId: 'T2', status: 418 }),
    k6Line({ kind: 'body_refusal', epochMinute: M1, tenantId: 'T3', reason: 'Tool-403' }),
    k6Line(minute(M2, 1, { s2xx: 4, assertions: 4, hist: { 40: 4 } })),
    'running (0m26.0s), 10/10 VUs, 0 complete and 0 interrupted iterations',
  ];

  it('publishes a finished minute the way the StressRun contract names it, and nothing the contract does not', () => {
    const r = relay(lines);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    expect(r.calls.length).toBe(2);
    const first = r.calls[0]!;
    for (const d of first) {
      const spec = METRICS[d.MetricName as keyof typeof METRICS];
      expect(spec).toBeDefined();
      expect(d.Unit).toBe(spec.unit);
      expect(d.Dimensions.map((x) => x.Name).sort()).toEqual([...spec.dimensions].sort());
      expect(dim(d, 'RunId')).toBe(RUN);
      expect(d.Timestamp).toBe(new Date(M1 * 60_000).toISOString().replace('.000Z', 'Z'));
    }
    expect(first.some((d) => /tenant|user|token/i.test(JSON.stringify(d.Dimensions)))).toBe(false);
  });

  it('sums the VUs of a minute: requests by class, assertions, mismatches, refusals seen and named', () => {
    const first = relay(lines).calls[0]!;
    const one = (name: string): number => named(first, name)[0]!.Value!;
    expect(one('IsolationAssertions')).toBe(19);
    expect(one('IsolationMismatches')).toBe(1);
    expect(dim(named(first, 'IsolationAssertions')[0]!, 'Slice')).toBe('agentic-runtime-isolation');
    expect(one('RefusalsSeen')).toBe(4);
    expect(one('RefusalsNamed')).toBe(5);
    const byClass = Object.fromEntries(named(first, 'Requests').map((d) => [dim(d, 'StatusClass'), d.Value]));
    expect(byClass).toEqual({ '2xx': 15, '4xx': 3, '5xx': 1 });
  });

  it('counts refusals by reason, folding an unlisted reason into other', () => {
    const first = relay(lines).calls[0]!;
    const byReason = Object.fromEntries(named(first, 'RefusalsByReason').map((d) => [dim(d, 'Reason'), d.Value]));
    expect(byReason).toEqual({ 'http-429': 3, 'other': 2 });
  });

  it('publishes the latency of a minute as a histogram, merged over the VUs, at most 150 buckets', () => {
    const h = named(relay(lines).calls[0]!, 'ClientLatencyMs')[0]!;
    expect(h.Counts).toEqual([8, 5, 6]);
    expect(h.Values!.length).toBe(h.Counts!.length);
    expect(h.Values!.length).toBeLessThanOrEqual(150);
    expect(h.Values![0]).toBeCloseTo(1.12 ** 40, 2);
    expect(h.Values).toEqual([...h.Values!].sort((a, b) => a - b));
  });

  it('keeps the dashboard\'s reason list and the relay\'s the same', () => {
    const text = fs.readFileSync(RELAY, 'utf8');
    const listed = /RELAY_REASONS:-([^}]+)\}/.exec(text)![1]!.split(' ');
    expect(listed).toEqual(REASONS.filter((r) => r !== 'other'));
  });

  it('on an ordinary pass publishes a minute every VU has finished and holds one that is still open', () => {
    const future = Math.floor(Date.now() / 60_000) + 1000;
    const open = [
      k6Line(minute(future, 1, { s2xx: 1, assertions: 1 })),
      k6Line(minute(future, 2, { s2xx: 1, assertions: 1 })),
      k6Line(minute(future + 1, 1, { s2xx: 1, assertions: 1 })),
    ];
    const r = relay(open, { RELAY_ONCE: 'pass' });
    expect(r.calls.length).toBe(1);
    expect(named(r.calls[0]!, 'IsolationAssertions')[0]!.Value).toBe(2);
    // One VU alone, no later minute, before its grace: nothing goes.
    expect(relay([k6Line(minute(future, 1, { s2xx: 1, assertions: 1 }))], { RELAY_ONCE: 'pass' }).calls).toEqual([]);
    // The same minute goes on the last pass.
    expect(relay([k6Line(minute(future, 1, { s2xx: 1, assertions: 1 }))]).calls.length).toBe(1);
  });

  it('stops on the stop file with a final pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const file = path.join(dir, 'k6.txt');
    fs.writeFileSync(file, `${k6Line(minute(Math.floor(Date.now() / 60_000) + 1000, 1, { s2xx: 1, assertions: 1 }))}\n`);
    const stop = path.join(dir, 'stop');
    fs.writeFileSync(stop, '');
    const stub = path.join(dir, 'aws');
    fs.writeFileSync(stub, '#!/usr/bin/env bash\necho called >> "$CAPTURE"\n', { mode: 0o755 });
    const capture = path.join(dir, 'calls');
    const r = spawnSync('bash', [RELAY], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, STRESS_RUN_ID: RUN, RECORD_SCENARIO: 'PS-2', AWS_REGION: 'eu-central-1', RELAY_FILE: file, RELAY_AWS: stub, RELAY_STOP_FILE: stop, CAPTURE: capture, RELAY_POLL_S: '1' },
      timeout: 20_000,
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(capture, 'utf8')).toBe('called\n');
  });

  it('keeps a failed minute for the next pass and says so, without failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const file = path.join(dir, 'k6.txt');
    fs.writeFileSync(file, `${[k6Line(minute(M1, 1, { s2xx: 1, assertions: 1 }))].join('\n')}\n`);
    const stub = path.join(dir, 'aws');
    fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "Throttling: rate exceeded" >&2\nexit 254\n', { mode: 0o755 });
    const r = spawnSync('bash', [RELAY], { encoding: 'utf8', env: { PATH: process.env.PATH, STRESS_RUN_ID: RUN, RECORD_SCENARIO: 'PS-2', AWS_REGION: 'eu-central-1', RELAY_FILE: file, RELAY_AWS: stub, RELAY_ONCE: '1' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('put-metric-data failed for minute');
    expect(r.stderr).toContain('Throttling');
  });

  it('refuses a run id or scenario that is not one, and a file that is missing is no error', () => {
    expect(relay([], { STRESS_RUN_ID: 'a b' }).status).toBe(2);
    expect(relay([], { RECORD_SCENARIO: 'PS 2; rm' }).status).toBe(2);
    const missing = spawnSync('bash', [RELAY], { encoding: 'utf8', env: { PATH: process.env.PATH, STRESS_RUN_ID: RUN, RECORD_SCENARIO: 'PS-2', AWS_REGION: 'eu-central-1', RELAY_FILE: '/nonexistent/k6.txt', RELAY_ONCE: '1' } });
    expect(missing.status).toBe(0);
  });
});
