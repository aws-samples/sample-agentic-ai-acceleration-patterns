// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The registry rules of spec §4.1 under contention and failure, against the
// in-memory DynamoDB with real condition semantics (ADR-0036).

import { harness, rowItem, seedSandbox, type Harness } from './harness';
import { handleLessStaleMs } from '../src/tool/config';
import { Logger } from '../src/tool/log';
import { runCode } from '../src/tool/run-code';
import type { RunCodeRequest, RunCodeResult } from '../src/tool/types';

const A = 'tenant-a';
const req = (over: Partial<RunCodeRequest> = {}): RunCodeRequest => ({ tenantId: A, code: 'print(1)', ...over });
const rowA = (h: Harness, backend: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => h.registry.get(A, backend);
const starts = (h: Harness, b: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => (h.backends.get(b)?.calls ?? []).filter((c) => c.startsWith('start')).length;
const ok = (r: RunCodeResult) => {
  if ('error' in r) throw new Error(`expected output, got ${JSON.stringify(r)}`);
  return r;
};

const seed = seedSandbox;

describe('two callers on one tenant', () => {
  test('cold: exactly one sandbox starts and both calls get a result', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 2;
    const [x, y] = await Promise.all([runCode(req(), h.deps), runCode(req(), h.deps)]);
    ok(x);
    ok(y);
    expect(starts(h)).toBe(1);
    expect(h.backends.get('microvm')!.jobs).toHaveLength(2);
    expect((await rowA(h))?.state).toBe('READY');
    expect(h.events('sandbox_stopped')).toHaveLength(0);
  });

  test('over a dead READY row: one takeover wins, one replacement starts, one stop line', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.kill('fake-1');
    const [x, y] = await Promise.all([runCode(req(), h.deps), runCode(req(), h.deps)]);
    ok(x);
    ok(y);
    expect(starts(h)).toBe(2);
    expect((await rowA(h))?.handle).toBe('fake-2');
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    expect(h.db.log.filter((l) => l.op === 'put' && !l.ok)).toHaveLength(1);
  });

  test('warm, with four callers: marks are retried then re-read, nobody runs on a stale snapshot, and every call returns a result', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.clock.t += 20 * 60_000;
    const results = await Promise.all([1, 2, 3, 4].map(() => runCode(req(), h.deps)));
    results.forEach((r) => ok(r));
    expect(starts(h)).toBe(1);
    expect((await rowA(h))?.suspendedMs).toBe(5 * 60_000);
  });

  test('when two STOPPING writes lose to busy callers the sandbox is still stopped, and the sandbox gets one line from whoever moves it', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const b = h.backends.get('microvm')!;
    b.script.nextRun = { kind: 'no_answer' };
    let lost = 0;
    h.db.hook = (op, input) => {
      if (op === 'update' && String(input.UpdateExpression).includes('#a0') && b.calls.some((c) => c.startsWith('run fake-1')) && lost < 2) {
        lost += 1;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 3;
      }
    };
    expect(ok(await runCode(req(), h.deps)).timedOut).toBe(true);
    expect(lost).toBe(2);
    expect((await rowA(h))?.state).toBe('STOPPING');
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    expect(b.stops.map((s) => s.handle)).toEqual(['fake-1']);
  });

  test('three start marks lost to other calls: the row is read again and the call still runs', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    let lost = 0;
    h.db.hook = (op, input) => {
      if (op === 'update' && String(input.UpdateExpression).startsWith('SET #last = :t') && lost < 3) {
        lost += 1;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.lastUsedAt = (item.lastUsedAt as number) + 1;
      }
    };
    h.clock.t += 1000;
    const out = ok(await runCode(req(), h.deps));
    expect(lost).toBe(3);
    expect(out.sandbox).toBe('reused');
  });

  test('a row with a state but no version (a partial write) does not wedge the tenant', async () => {
    const h = harness();
    h.db.seed({ PK: 'TENANT#tenant-a', SK: 'SANDBOX#microvm', state: 'READY', handle: 'h' });
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('started');
  });

  test('warm: both start marks land, the loser re-reads, and the idle gap is counted once', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.clock.t += 20 * 60_000;
    const [x, y] = await Promise.all([runCode(req(), h.deps), runCode(req(), h.deps)]);
    ok(x);
    ok(y);
    expect(starts(h)).toBe(1);
    // idle is 15 min, the gap 20 min: 5 min suspended, added by one writer only
    expect((await rowA(h))?.suspendedMs).toBe(5 * 60_000);
  });

  test('a rival that wins the takeover between the read and the write leaves this call waiting, not starting', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.kill('fake-1');
    h.db.hook = (op) => {
      if (op === 'put') {
        h.db.hook = undefined;
        // the rival's takeover lands first: a new STARTING row, version moved, no handle yet
        h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 20_000, version: 9 }, h.clock.t));
      }
    };
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 5 });
    expect(starts(h)).toBe(1);
    expect(await rowA(h)).toMatchObject({ state: 'STARTING', version: 9 });
    // it waited the whole startWait for the rival, and no more
    expect(h.clock.t).toBeGreaterThanOrEqual(1_700_000_000_000 + 15_000);
  });

  test('a call that keeps losing the takeover gives up after a few re-reads with sandbox_starting', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'FAILED', retryAt: h.clock.t - 1, version: 1 }, h.clock.t));
    h.db.hook = (op) => {
      if (op === 'put') {
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 1;
      }
    };
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 5 });
    expect(starts(h)).toBe(0);
    expect(h.db.log.filter((l) => l.op === 'put')).toHaveLength(5);
  });
});

describe('a start that crashed or never finished', () => {
  test('a handle-less STARTING row within its window is waited on, not taken over', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 20_000 }, h.clock.t));
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 5 });
    expect(starts(h)).toBe(0);
  });

  test('a handle-less STARTING row past startWait + the tool timeout is taken over at once, with no stop line', async () => {
    const h = harness();
    const age = handleLessStaleMs(h.deps.config) + 1;
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t - age, leaseUntil: h.clock.t - age + 20_000 }, h.clock.t));
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('started');
    expect(starts(h)).toBe(1);
    expect(h.events('sandbox_stopped')).toHaveLength(0);
    expect((await rowA(h))?.version).toBeGreaterThan(1);
  });

  test('the window edge is exact: at the limit the row is still another call\'s start', async () => {
    const h = harness({ startWaitMs: 0 });
    const age = handleLessStaleMs(h.deps.config);
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t - age, leaseUntil: h.clock.t - age + 20_000 }, h.clock.t));
    expect(await runCode(req(), h.deps)).toMatchObject({ error: 'sandbox_starting' });
  });

  test('a STARTING row whose lease ran out with the sandbox neither ended nor ready becomes FAILED, stopped, with one stop line', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 1000;
    const handle = await seed(h, 'STARTING', { leaseUntil: h.clock.t - 1 });
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 30 });
    expect(await rowA(h)).toMatchObject({ state: 'FAILED', retryAt: h.clock.t + 30_000, handle: handle.handle });
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual([handle.handle]);
    const [line] = h.events('sandbox_stopped');
    expect(line).toMatchObject({ handle: handle.handle, reason: 'failed_start', stoppedReason: 'start_cap', by: 'tool' });
    expect(h.events('run')[0]).toMatchObject({ outcome: 'sandbox_failed', stoppedReason: 'start_cap' });
    expect(starts(h)).toBe(1);
  });

  test('a STARTING row that turns ready within the lease is promoted by whichever call finds it, after waiting', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 3;
    await seed(h, 'STARTING');
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('started');
    expect(await rowA(h)).toMatchObject({ state: 'READY' });
    expect(starts(h)).toBe(1);
    expect(h.clock.t).toBe(1_700_000_000_000 + 3 * 500);
  });

  test('a start not ready within startWait is sandbox_starting; the row stays STARTING and nothing is stopped', async () => {
    const h = harness({ startWaitMs: 2000 });
    h.backends.get('microvm')!.script.startingProbes = 1000;
    await seed(h, 'STARTING');
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 5 });
    expect((await rowA(h))?.state).toBe('STARTING');
    expect(h.backends.get('microvm')!.stops).toEqual([]);
    expect(h.clock.t).toBe(1_700_000_000_000 + 2000);
  });

  test('startWait 0 probes once and does not sleep', async () => {
    const h = harness({ startWaitMs: 0 });
    h.backends.get('microvm')!.script.startingProbes = 1000;
    expect(await runCode(req(), h.deps)).toMatchObject({ error: 'sandbox_starting' });
    expect(h.clock.t).toBe(1_700_000_000_000);
  });

  test('the sandbox ended before it was ready: FAILED, the platform reason on the stop line, sandbox_failed', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.endBeforeReady = 'Essential container exited';
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 30 });
    expect(await rowA(h)).toMatchObject({ state: 'FAILED', handle: 'fake-1' });
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ reason: 'failed_start', stoppedReason: 'Essential container exited' });
    expect(h.events('run')[0]).toMatchObject({ stoppedReason: 'Essential container exited' });
  });

  test('a start call that throws leaves a FAILED row with no handle and no stop line', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.failStart = new Error('ThrottlingException with a message that must not be logged');
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 30 });
    const row = await rowA(h);
    expect(row).toMatchObject({ state: 'FAILED', retryAt: h.clock.t + 30_000 });
    expect(row?.handle).toBeUndefined();
    expect(h.events('sandbox_stopped')).toHaveLength(0);
    expect(JSON.stringify(h.lines)).not.toContain('must not be logged');
    expect(h.events('run')[0]).toMatchObject({ outcome: 'sandbox_failed', stoppedReason: 'Error' });
  });
});

describe('the FAILED backoff', () => {
  test('no takeover before retryAt; the caller is told how long to wait; nothing is written', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'FAILED', retryAt: h.clock.t + 20_500, version: 4 }, h.clock.t));
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 21 });
    expect(starts(h)).toBe(0);
    expect(h.db.log.map((l) => l.op)).toEqual(['get']);
    expect(await rowA(h)).toMatchObject({ state: 'FAILED', version: 4 });
  });

  test('at retryAt the next call takes over and starts', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'FAILED', retryAt: h.clock.t + 1000, version: 4 }, h.clock.t));
    h.clock.t += 1000;
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('started');
    expect(await rowA(h)).toMatchObject({ state: 'READY' });
    expect(h.events('sandbox_stopped')).toHaveLength(0);
  });

  test('one failed start, then calls inside the backoff cost nothing, then one inside the next window', async () => {
    const h = harness();
    const b = h.backends.get('microvm')!;
    b.script.failStart = new Error('x');
    await runCode(req(), h.deps);
    b.script.failStart = undefined;
    h.clock.t += 10_000;
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 20 });
    expect(starts(h)).toBe(1);
    h.clock.t += 20_000;
    ok(await runCode(req(), h.deps));
    expect(starts(h)).toBe(2);
  });
});

describe('credentials, roles and unexpected faults', () => {
  test('the stop of a replaced nitro task carries the tenant credentials (StopTask is tag-conditioned)', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await runCode(req(), h.deps);
    h.backends.get('nitro')!.kill('fake-1');
    ok(await runCode(req(), h.deps));
    const stop = h.backends.get('nitro')!.stops[0];
    expect(stop.creds?.tenantId).toBe(A);
  });

  test('credentials that cannot be vended are tool_failed, and nothing else runs', async () => {
    const h = harness();
    const deps = { ...h.deps, credentials: async () => { throw new Error('AccessDenied'); } };
    expect(await runCode(req(), deps)).toEqual({ error: 'tool_failed' });
    expect(h.db.log).toEqual([]);
    expect(h.events('run')[0]).toMatchObject({ tenantId: A, outcome: 'tool_failed', stoppedReason: 'Error' });
  });

  test('an exception from a backend is tool_failed, never thrown', async () => {
    const h = harness();
    jest.spyOn(h.backends.get('microvm')!, 'ready').mockRejectedValue(new TypeError('boom'));
    expect(await runCode(req(), h.deps)).toEqual({ error: 'tool_failed' });
    expect(h.events('run')[0]).toMatchObject({ outcome: 'tool_failed', stoppedReason: 'TypeError' });
  });

  test('a failed stop of a replaced sandbox does not fail the call', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.kill('fake-1');
    jest.spyOn(h.backends.get('microvm')!, 'stop').mockRejectedValue(new Error('x'));
    ok(await runCode(req(), h.deps));
    expect(h.events('stop_failed')).toHaveLength(1);
  });

  test('a row deleted while the sandbox starts leaves an orphan the tool stops and records', async () => {
    const h = harness();
    h.db.hook = (op, input) => {
      if (op === 'update' && String(input.UpdateExpression).includes('#a0') && h.backends.get('microvm')!.calls.some((c) => c.startsWith('start'))) {
        h.db.hook = undefined;
        h.db.items.clear();
      }
    };
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_starting', retryAfterSeconds: 1 });
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ handle: 'fake-1', orphan: true, reason: 'orphan' });
  });
});

describe('what the lines say', () => {
  test('a microvm stop line splits running and suspended time from the idle gaps', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.clock.t += 20 * 60_000;
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'no_answer' };
    h.clock.t += 1000;
    await runCode(req(), h.deps);
    const [line] = h.events('sandbox_stopped');
    expect(line).toMatchObject({ tenantId: A, backend: 'microvm', handle: 'fake-1', reason: 'overrun', estimated: true });
    expect(line.suspendedSeconds).toBe(300);
    expect(line.runningSeconds).toBe((line.sandboxSeconds as number) - 300);
    expect((await rowA(h))?.suspendedMs).toBe(300_000);
  });

  test('a nitro stop line has no running or suspended split', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await runCode(req(), h.deps);
    h.backends.get('nitro')!.script.nextRun = { kind: 'no_answer' };
    await runCode(req(), h.deps);
    const [line] = h.events('sandbox_stopped');
    expect(line.runningSeconds).toBeUndefined();
    expect(line.estimated).toBeUndefined();
  });

  test('with perTenantMetrics a run and a stop each emit an EMF line keyed by TenantId and Backend', async () => {
    const h = harness({ perTenantMetrics: true });
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'no_answer' };
    await runCode(req(), h.deps);
    const emf = h.lines.filter((l) => '_aws' in l);
    expect(emf).toHaveLength(3);
    expect(emf[0]).toMatchObject({ TenantId: A, Backend: 'microvm', Runs: 1, Errors: 0 });
    expect(emf[1]).toMatchObject({ TenantId: A, Backend: 'microvm' });
    expect(emf[1]).toHaveProperty('SandboxSeconds');
    expect(emf[2]).toMatchObject({ Runs: 1, Errors: 0 });
    const spec = (emf[0]._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }> }).CloudWatchMetrics[0];
    expect(spec.Dimensions).toEqual([['TenantId', 'Backend']]);
    expect(spec.Metrics.map((m) => m.Name)).toEqual(['Runs', 'Errors', 'RunDuration']);
  });

  test('without perTenantMetrics there is no EMF line', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    expect(h.lines.some((l) => '_aws' in l)).toBe(false);
  });

  test('lines are written through process.stdout.write with the fields at the top level', async () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const h = harness();
      await runCode(req(), { ...h.deps, log: new Logger() });
    } finally {
      spy.mockRestore();
    }
    const lines = written.map((w) => JSON.parse(w));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'run', tenantId: A, outcome: 'ok' });
    expect(written[0].endsWith('\n')).toBe(true);
  });
});
