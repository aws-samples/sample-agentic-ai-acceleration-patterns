// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// runCode against a fake backend and an in-memory DynamoDB with real
// condition semantics (ADR-0036). Behaviour only a real backend can show
// (the wire, the platform's idea of "gone") is out of reach here.

import { harness, maintenanceDeps, rowItem, signedResult, type Harness } from './harness';
import { jobAuth } from '../src/protocol';
import { reapOnce } from '../src/reaper/reaper';
import { capOutput, runCode } from '../src/tool/run-code';
import type { RunCodeRequest, RunCodeResult } from '../src/tool/types';

const A = 'tenant-a';
const B = 'tenant-b';
const req = (over: Partial<RunCodeRequest> = {}): RunCodeRequest => ({ tenantId: A, code: 'print(1)', ...over });
const rowA = (h: Harness, tenant = A, backend: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => h.registry.get(tenant, backend);
const starts = (h: Harness, b: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => (h.backends.get(b)?.calls ?? []).filter((c) => c.startsWith('start')).length;
const ok = (r: RunCodeResult) => {
  if ('error' in r) throw new Error(`expected output, got ${JSON.stringify(r)}`);
  return r;
};

describe('a first call', () => {
  test('starts the sandbox, runs the job, and leaves a READY row', async () => {
    const h = harness();
    const out = ok(await runCode(req(), h.deps));
    expect(out).toMatchObject({ runId: 'run-1', backend: 'microvm', exitCode: 0, timedOut: false, memoryExceeded: false, truncated: false, sandbox: 'started' });
    const row = await rowA(h);
    expect(row).toMatchObject({ state: 'READY', handle: 'fake-1', address: 'addr-fake-1', tenantId: A });
    expect(row?.lastUsedAt).toBeDefined();
    expect(row?.expiresAt).toBe((row?.createdAt ?? 0) + 8 * 3_600_000);
    expect(row?.ttlAt).toBe(Math.floor(((row?.expiresAt ?? 0) + 3_600_000) / 1000));
    expect(starts(h)).toBe(1);
  });

  test('sends a job bound to the row nonce, with the configured caps and no input', async () => {
    const h = harness({ runTimeoutMs: 12_000, maxOutputBytes: 1000 });
    await runCode(req({ code: 'x = 1' }), h.deps);
    const row = await rowA(h);
    const job = h.backends.get('microvm')?.jobs[0];
    expect(job).toMatchObject({ v: 1, tenantId: A, nonce: row?.nonce, code: 'x = 1', timeoutMs: 12_000, maxOutputBytes: 1000, runId: 'run-1' });
    expect(job?.input).toBeUndefined();
    expect(job?.jobAuth).toBe(jobAuth(row?.nonce ?? '', 'run-1', A, 'x = 1'));
  });

  test('writes one run line with top-level fields and nothing the tenant sent', async () => {
    const h = harness();
    await runCode(req({ code: 'secret_code_marker = 1' }), h.deps);
    const [line] = h.events('run');
    expect(line).toMatchObject({ tenantId: A, backend: 'microvm', handle: 'fake-1', runId: 'run-1', sandbox: 'started', outcome: 'ok', exitCode: 0, timedOut: false, inputBytes: 0, outputBytes: 0 });
    expect(typeof line.startMs).toBe('number');
    expect(typeof line.durationMs).toBe('number');
    expect(JSON.stringify(h.lines)).not.toContain('secret_code_marker');
    expect(JSON.stringify(h.lines)).not.toContain('nonce');
  });
});

describe('a later call', () => {
  test('reuses the sandbox, moves lastUsedAt forward and starts nothing', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const first = await rowA(h);
    h.clock.t += 60_000;
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('reused');
    expect(out.runId).toBe('run-2');
    expect(starts(h)).toBe(1);
    const second = await rowA(h);
    expect(second?.lastUsedAt).toBe(h.clock.t);
    expect(second?.version).toBeGreaterThan(first?.version ?? 0);
    expect(second?.nonce).toBe(first?.nonce);
    // the per-call line names the sandbox on a reused call too: AgentCore cost is joined through it (spec §3.8)
    expect(h.events('run').map((l) => [l.sandbox, l.handle])).toEqual([['started', 'fake-1'], ['reused', 'fake-1']]);
  });

  test('another tenant gets its own sandbox, its own credentials and its own row', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const out = ok(await runCode(req({ tenantId: B }), h.deps));
    expect(out.sandbox).toBe('started');
    expect((await rowA(h, A))?.handle).toBe('fake-1');
    expect((await rowA(h, B))?.handle).toBe('fake-2');
    expect(h.credsFor).toEqual([A, B]);
    expect(h.backends.get('microvm')?.jobs.map((j) => j.tenantId)).toEqual([A, B]);
  });

  test('a READY row past expiresAt is replaced, and the old sandbox is stopped with one stop line', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.clock.t += 8 * 3_600_000 + 1;
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('started');
    expect(h.backends.get('microvm')?.stops.map((s) => s.handle)).toEqual(['fake-1']);
    const stops = h.events('sandbox_stopped');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ tenantId: A, backend: 'microvm', handle: 'fake-1', by: 'tool', reason: 'expired', sandboxSeconds: 8 * 3600 });
    expect((await rowA(h))?.handle).toBe('fake-2');
  });
});

describe('validation', () => {
  test.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['leading hyphen', '-a'],
    ['leading underscore', '_a'],
    ['a hash', 'a#b'],
    ['a slash', 'a/b'],
    ['a space', 'a b'],
    ['a colon', 'a:b'],
    ['a newline', 'a\n'],
    ['non-ASCII', 'tenänt'],
  ])('refuses a tenant id with %s before any credentials or sandbox', async (_n, tenantId) => {
    const h = harness();
    expect(await runCode(req({ tenantId }), h.deps)).toEqual({ error: 'invalid_argument' });
    expect(h.credsFor).toEqual([]);
    expect(h.db.log).toEqual([]);
    expect(starts(h)).toBe(0);
    expect(h.events('run')[0]).toMatchObject({ tenantId: 'invalid', outcome: 'invalid_argument' });
  });

  test('a refusal after the tenant id passed is counted against that tenant, not against "invalid"', async () => {
    const h = harness();
    await runCode(req({ code: 5 as never }), h.deps);
    await runCode(req({ backend: 'agentcore' }), h.deps);
    await runCode(req({ tenantId: 'bad id' }), h.deps);
    expect(h.events('run').map((l) => [l.tenantId, l.outcome])).toEqual([
      [A, 'invalid_argument'], [A, 'backend_disabled'], ['invalid', 'invalid_argument'],
    ]);
  });

  test.each([
    ['one character', 'a'],
    ['64 characters', `a${'-_'.repeat(31)}b`.slice(0, 64)],
    ['digits first', '9tenant'],
    ['hyphens and underscores', 'a-b_c-d'],
  ])('accepts a tenant id with %s', async (_n, tenantId) => {
    const h = harness();
    expect(tenantId.length).toBeLessThanOrEqual(64);
    ok(await runCode(req({ tenantId }), h.deps));
    expect(await h.registry.get(tenantId, 'microvm')).toMatchObject({ tenantId, state: 'READY' });
  });

  test('the 64-character limit is exact', async () => {
    const h = harness();
    expect(ok(await runCode(req({ tenantId: 'a'.repeat(64) }), h.deps)).sandbox).toBe('started');
    expect(await runCode(req({ tenantId: 'a'.repeat(65) }), h.deps)).toEqual({ error: 'invalid_argument' });
  });

  test.each([
    ['not an object', 'text'],
    ['null', null],
    ['no tenant', { code: 'x' }],
    ['a numeric tenant', { tenantId: 7, code: 'x' }],
    ['no code', { tenantId: A }],
    ['numeric code', { tenantId: A, code: 3 }],
    ['code over 64 KiB', { tenantId: A, code: 'a'.repeat(65537) }],
    ['multi-byte code over 64 KiB', { tenantId: A, code: 'é'.repeat(32769) }],
    ['a lone surrogate', { tenantId: A, code: 'a\ud800b' }],
    ['input with ..', { tenantId: A, code: 'x', input: 'a/../b' }],
    ['input with a leading slash', { tenantId: A, code: 'x', input: '/a' }],
    ['input with a space', { tenantId: A, code: 'x', input: 'a b' }],
    ['empty input name', { tenantId: A, code: 'x', input: '' }],
    ['input over 256', { tenantId: A, code: 'x', input: 'a'.repeat(257) }],
    ['numeric input name', { tenantId: A, code: 'x', input: 1 }],
    ['unknown backend', { tenantId: A, code: 'x', backend: 'lambda' }],
    ['saveOutput as a string', { tenantId: A, code: 'x', saveOutput: 'yes' }],
  ])('refuses %s', async (_n, request) => {
    const h = harness();
    expect(await runCode(request as never, h.deps)).toEqual({ error: 'invalid_argument' });
    expect(h.credsFor).toEqual([]);
  });

  test('accepts code of exactly 64 KiB, empty code, and an input name of 256 characters', async () => {
    const h = harness();
    ok(await runCode(req({ code: 'a'.repeat(65536) }), h.deps));
    ok(await runCode(req({ code: '' }), h.deps));
    h.objects.objects.set(`inputs/${A}/${'a'.repeat(256)}`, new Uint8Array([1]));
    ok(await runCode(req({ input: 'a'.repeat(256) }), h.deps));
  });

  test('a backend that is valid but not deployed is backend_disabled; a deployed one is chosen by name', async () => {
    const h = harness({ backends: ['microvm', 'nitro'], defaultBackend: 'microvm' });
    expect(await runCode(req({ backend: 'agentcore' }), h.deps)).toEqual({ error: 'backend_disabled' });
    expect(ok(await runCode(req({ backend: 'nitro' }), h.deps)).backend).toBe('nitro');
    expect(ok(await runCode(req(), h.deps)).backend).toBe('microvm');
    expect(await rowA(h, A, 'nitro')).toMatchObject({ state: 'READY' });
    expect(await rowA(h, A, 'microvm')).toMatchObject({ state: 'READY' });
  });
});

describe('the input', () => {
  const key = (name: string, tenant = A) => `inputs/${tenant}/${name}`;

  test('is fetched with the tenant credentials before any sandbox starts, and its bytes are signed into the job', async () => {
    const h = harness();
    const bytes = new Uint8Array([0, 255, 10, 200, 3]);
    h.objects.objects.set(key('data/in.bin'), bytes);
    const order: string[] = [];
    const original = h.backends.get('microvm')!.start.bind(h.backends.get('microvm'));
    jest.spyOn(h.backends.get('microvm')!, 'start').mockImplementation(async (...a) => {
      order.push('start');
      return original(...a);
    });
    const objectsFor = h.deps.objectsFor;
    const deps = {
      ...h.deps,
      objectsFor: (c: Parameters<typeof objectsFor>[0]) => {
        order.push('objects');
        return objectsFor(c);
      },
    };
    ok(await runCode(req({ input: 'data/in.bin' }), deps));
    expect(order.indexOf('objects')).toBeLessThan(order.indexOf('start'));
    expect(h.objects.reads).toEqual([key('data/in.bin')]);
    const job = h.backends.get('microvm')!.jobs[0];
    expect(Buffer.from(job.input ?? '', 'base64')).toEqual(Buffer.from(bytes));
    expect(job.jobAuth).toBe(jobAuth(job.nonce, job.runId, A, 'print(1)', bytes));
    expect(h.events('run')[0].inputBytes).toBe(5);
  });

  test('an empty object is an input of zero bytes; it signs like no input, but travels as ""', async () => {
    const h = harness();
    h.objects.objects.set(key('empty'), new Uint8Array(0));
    ok(await runCode(req({ input: 'empty' }), h.deps));
    ok(await runCode(req(), h.deps));
    const [withEmpty, without] = h.backends.get('microvm')!.jobs;
    expect(withEmpty.input).toBe('');
    expect(without.input).toBeUndefined();
    expect(withEmpty.jobAuth).toBe(jobAuth(withEmpty.nonce, 'run-1', A, 'print(1)'));
  });

  test('a missing object is input_not_found, and nothing starts', async () => {
    const h = harness();
    expect(await runCode(req({ input: 'nope' }), h.deps)).toEqual({ error: 'input_not_found' });
    expect(starts(h)).toBe(0);
    expect(h.events('run')[0]).toMatchObject({ outcome: 'input_not_found' });
  });

  test('an object over maxInputBytes is input_too_large, and nothing starts', async () => {
    const h = harness({ maxInputBytes: 4 });
    h.objects.objects.set(key('big'), new Uint8Array(5));
    h.objects.objects.set(key('fits'), new Uint8Array(4));
    expect(await runCode(req({ input: 'big' }), h.deps)).toEqual({ error: 'input_too_large' });
    expect(starts(h)).toBe(0);
    ok(await runCode(req({ input: 'fits' }), h.deps));
  });

  test("never reads another tenant's object: the key is built from the call's tenant alone", async () => {
    const h = harness();
    h.objects.objects.set(key('secret', B), new Uint8Array([9]));
    expect(await runCode(req({ input: 'secret' }), h.deps)).toEqual({ error: 'input_not_found' });
    expect(h.objects.reads).toEqual([key('secret', A)]);
  });
});

describe('what the runner returns', () => {
  async function withResult(over: Parameters<typeof signedResult>[2]) {
    const h = harness();
    await runCode(req(), h.deps);
    const b = h.backends.get('microvm')!;
    const row = await rowA(h);
    b.script.nextRun = signedResult(row?.nonce ?? '', 'run-2', over);
    return { h, out: ok(await runCode(req(), h.deps)) };
  }

  test('a script that exits non-zero is a result, not an error', async () => {
    const { out } = await withResult({ exitCode: 3, stderr: 'boom', stdout: 'partial' });
    expect(out).toMatchObject({ exitCode: 3, stderr: 'boom', stdout: 'partial', timedOut: false });
  });

  test('memoryExceeded, timedOut, truncated and a signal exit code pass through', async () => {
    const { out } = await withResult({ exitCode: -9, memoryExceeded: true, timedOut: true, truncated: true, durationMs: 777 });
    expect(out).toMatchObject({ exitCode: -9, memoryExceeded: true, timedOut: true, truncated: true, durationMs: 777 });
  });

  test('output the runner cut is returned whole and truncated stays as the runner set it', async () => {
    const { out } = await withResult({ stdout: '\ufffd'.repeat(10), stderr: 'e', truncated: false });
    expect(out).toMatchObject({ stdout: '\ufffd'.repeat(10), stderr: 'e', truncated: false });
  });

  test('output whose JSON form is above the response budget is cut, stdout first, and marked truncated', async () => {
    // 0x01 is one raw byte and six JSON bytes: a 4 MiB output at the cap would be 24 MiB on the wire.
    const cap = 4 * 1024 * 1024;
    const { out } = await withResult({ stdout: '\u0001'.repeat(cap - 10), stderr: 'e'.repeat(10) });
    expect(out.truncated).toBe(true);
    expect(out.stderr).toBe('e'.repeat(10));
    expect(JSON.stringify(out).length).toBeLessThan(5 * 1024 * 1024 + 4096);
    expect(out.stdout.length).toBeGreaterThan(800_000);
  });

  test('a result with a wrong proof is a dead handle: the sandbox is replaced once', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const bad = signedResult('A'.repeat(43), 'run-2');
    h.backends.get('microvm')!.script.nextRun = bad;
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('started');
    expect(starts(h)).toBe(2);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('a result for another runId is a dead handle', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const row = await rowA(h);
    h.backends.get('microvm')!.script.nextRun = signedResult(row?.nonce ?? '', 'run-other');
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('started');
  });

  test('a changed bootId is a restart: the row is rewritten and the call reports started', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const row = await rowA(h);
    h.backends.get('microvm')!.script.nextRun = signedResult(row?.nonce ?? '', 'run-2', { bootId: 'c'.repeat(32) });
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('started');
    expect((await rowA(h))?.bootId).toBe('c'.repeat(32));
    h.backends.get('microvm')!.script.nextRun = signedResult(row?.nonce ?? '', 'run-3', { bootId: 'c'.repeat(32) });
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('reused');
    expect(starts(h)).toBe(1);
  });

  test('the first bootId a row sees is recorded without calling it a restart (agentcore)', async () => {
    const h = harness({ backends: ['agentcore'], defaultBackend: 'agentcore' });
    const first = await runCode(req(), h.deps);
    ok(first);
    // the fake reports a bootId from ready, so drop it from the row to look like agentcore
    const item = h.db.row('TENANT#tenant-a', 'SANDBOX#agentcore')!;
    delete item.bootId;
    const row = await rowA(h, A, 'agentcore');
    h.backends.get('agentcore')!.script.nextRun = signedResult(row?.nonce ?? '', 'run-2', { bootId: 'd'.repeat(32) });
    expect(ok(await runCode(req(), h.deps)).sandbox).toBe('reused');
    expect((await rowA(h, A, 'agentcore'))?.bootId).toBe('d'.repeat(32));
  });

  test('saveOutput writes outputs/<tenant>/<runId>.json with the tenant credentials', async () => {
    const h = harness();
    const out = ok(await runCode(req({ saveOutput: true }), h.deps));
    expect(h.objects.writes).toHaveLength(1);
    expect(h.objects.writes[0].key).toBe(`outputs/${A}/run-1.json`);
    expect(JSON.parse(h.objects.writes[0].body)).toEqual(out);
    ok(await runCode(req(), h.deps));
    expect(h.objects.writes).toHaveLength(1);
  });

  test('a failed output write is tool_failed', async () => {
    const h = harness();
    const deps = { ...h.deps, objectsFor: () => ({ readInput: async () => new Uint8Array(0), writeOutput: async () => { throw new Error('denied'); } }) };
    expect(await runCode(req({ saveOutput: true }), deps)).toEqual({ error: 'tool_failed' });
    expect(h.events('run')[0]).toMatchObject({ outcome: 'tool_failed', stoppedReason: 'Error' });
  });
});

describe('a sandbox that is not the one the call read', () => {
  test('a stale writer cannot flip a recreated row: version numbers restart at 1, the nonce does not', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const held = (await rowA(h))!;
    h.db.items.clear();
    await runCode(req(), h.deps);
    const recreated = (await rowA(h))!;
    expect(recreated.version).toBe(held.version);
    expect(recreated.nonce).not.toBe(held.nonce);
    expect(await h.registry.update(held, { state: 'STOPPING' })).toBeUndefined();
    expect(await h.registry.delete(held)).toBe(false);
    expect((await rowA(h))?.state).toBe('READY');
  });

  test('a call that overruns on a row recreated meanwhile leaves the new sandbox alone', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const b = h.backends.get('microvm')!;
    b.script.nextRun = { kind: 'no_answer' };
    h.db.hook = (op, input) => {
      if (op === 'update' && String(input.UpdateExpression).includes('#a0') && b.calls.some((c) => c.startsWith('run fake-1'))) {
        h.db.hook = undefined;
        h.db.items.clear();
        h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'READY', handle: 'fake-9', version: (1), lastUsedAt: h.clock.t }, h.clock.t));
      }
    };
    expect(ok(await runCode(req(), h.deps)).timedOut).toBe(true);
    expect((await rowA(h))).toMatchObject({ state: 'READY', handle: 'fake-9' });
    expect(b.stops).toEqual([]);
  });

  test.each(['x'.repeat(2000), 'x'.repeat(32), 'A'.repeat(32), 'a'.repeat(31)])('a runner bootId that is not 32 lowercase hex (%#) is a dead handle, never written to the row', async (bootId) => {
    const h = harness();
    await runCode(req(), h.deps);
    const row = await rowA(h);
    h.backends.get('microvm')!.script.nextRun = signedResult(row?.nonce ?? '', 'run-2', { bootId });
    ok(await runCode(req(), h.deps));
    expect(h.backends.get('microvm')!.sandboxes.size).toBe(2);
    expect((await rowA(h))?.bootId).not.toBe(bootId);
  });

  test('capOutput cuts between characters and counts JSON bytes', () => {
    const [stdout, stderr, cut] = capOutput('a\u00e9\u00e9\u00e9', '\n\n', 7);
    expect([stdout, stderr, cut]).toEqual(['a\u00e9', '\n\n', true]);
    expect(capOutput('ab', 'cd', 4)).toEqual(['ab', 'cd', false]);
    expect(capOutput('\ud83d\ude00\ud83d\ude00', '', 5)[0]).toBe('\ud83d\ude00');
  });

  test('a second sandbox is not started when too little of the function\'s time is left: the dead handle is failed, not kept', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } };
    const result = await runCode(req(), h.deps, { remainingMs: () => 10_000 });
    expect(result).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 30 });
    expect(starts(h)).toBe(1);
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual(['fake-1']);
    expect(await rowA(h)).toMatchObject({ state: 'FAILED', handle: 'fake-1' });
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ handle: 'fake-1', reason: 'dead' })]);
    h.clock.t += 30_000;
    ok(await runCode(req(), h.deps, { remainingMs: () => 120_000 }));
    expect(starts(h)).toBe(2);
  });

  test('with time to spare a dead handle is replaced in the same call', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } };
    expect(ok(await runCode(req(), h.deps, { remainingMs: () => 120_000 })).sandbox).toBe('started');
  });

  test('the sandbox being replaced stays named on the new row, and the reaper does not line it as an orphan meanwhile', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.clock.t += 60_000;
    const b = h.backends.get('microvm')!;
    b.kill('fake-1');
    b.sandboxes.get('fake-1')!.live = true;
    b.script.nextRun = { kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } };
    const realStop = b.stop.bind(b);
    let pass: unknown;
    let ran = false;
    jest.spyOn(b, 'stop').mockImplementation(async (handle, creds) => {
      // the takeover is written and the old sandbox is not yet stopped: a reaper pass runs now (once: it stops fake-1 itself)
      if (handle.handle === 'fake-1' && !ran) {
        ran = true;
        pass = await reapOnce(maintenanceDeps(h));
      }
      return realStop(handle, creds);
    });
    ok(await runCode(req(), h.deps));
    expect(pass).toMatchObject({ orphans: 0 });
    expect(h.events('sandbox_stopped').filter((l) => l.handle === 'fake-1')).toEqual([expect.objectContaining({ by: 'tool', reason: 'dead' })]);
    expect(h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')?.replaces).toBe('fake-1');
  });
});

describe('refusals and dead handles', () => {
  test('busy is sandbox_busy, and the start mark still moved lastUsedAt', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.sandboxes.get('fake-1')!.busy = true;
    h.clock.t += 5000;
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_busy' });
    expect((await rowA(h))?.lastUsedAt).toBe(h.clock.t);
    expect(starts(h)).toBe(1);
  });

  test('a tool_failed refusal from the runner is tool_failed and keeps the row', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'refused', refusal: { v: 1, error: 'tool_failed' } };
    expect(await runCode(req(), h.deps)).toEqual({ error: 'tool_failed' });
    expect((await rowA(h))?.state).toBe('READY');
    expect(starts(h)).toBe(1);
  });

  test.each(['wrong_sandbox', 'dirty'] as const)('%s marks the handle dead: one fresh start, one stop line, a result', async (error) => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'refused', refusal: { v: 1, error } };
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('started');
    expect(starts(h)).toBe(2);
    expect((await rowA(h))?.handle).toBe('fake-2');
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual(['fake-1']);
    const stops = h.events('sandbox_stopped');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ handle: 'fake-1', reason: 'dead', by: 'tool' });
    const jobs = h.backends.get('microvm')!.jobs;
    expect(jobs[1].nonce).not.toBe(jobs[2].nonce);
    expect(jobs[1].runId).toBe(jobs[2].runId);
  });

  test('a handle that is gone is dead too, whatever the cause', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.kill('fake-1');
    const out = ok(await runCode(req(), h.deps));
    expect(out.sandbox).toBe('started');
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('a second dead handle in one call stops retrying: FAILED, a backoff, one more stop line', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    const b = h.backends.get('microvm')!;
    jest.spyOn(b, 'run').mockResolvedValue({ kind: 'refused', refusal: { v: 1, error: 'wrong_sandbox' } });
    expect(await runCode(req(), h.deps)).toEqual({ error: 'sandbox_failed', retryAfterSeconds: 30 });
    expect(starts(h)).toBe(2);
    expect(await rowA(h)).toMatchObject({ state: 'FAILED', retryAt: h.clock.t + 30_000 });
    expect(h.events('sandbox_stopped').map((l) => l.handle)).toEqual(['fake-1', 'fake-2']);
    expect(h.events('run').at(-1)).toMatchObject({ outcome: 'sandbox_failed', stoppedReason: 'dead' });
  });
});

describe('the runner never answers', () => {
  test('sets STOPPING, stops the sandbox, writes one stop line, and returns timedOut', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'no_answer' };
    h.clock.t += 1000;
    const out = ok(await runCode(req(), h.deps));
    expect(out).toMatchObject({ timedOut: true, exitCode: -9, stdout: '', stderr: '', truncated: false, memoryExceeded: false, sandbox: 'reused' });
    expect(await rowA(h)).toMatchObject({ state: 'STOPPING' });
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ reason: 'overrun', handle: 'fake-1' });
    // the next call replaces the STOPPING row without another stop line
    const next = ok(await runCode(req(), h.deps));
    expect(next.sandbox).toBe('started');
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('when another call moved the row, the same handle is still stopped, and this call writes the one line', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'no_answer' };
    let bumped = false;
    h.db.hook = (op, input) => {
      // between the run and the STOPPING write, a rival writes the row (version moves, handle stays)
      if (op === 'update' && String(input.UpdateExpression).includes('#a0') && !bumped && h.backends.get('microvm')!.calls.some((c) => c.startsWith('run fake-1'))) {
        bumped = true;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 5;
      }
    };
    const out = ok(await runCode(req(), h.deps));
    expect(bumped).toBe(true);
    expect(out.timedOut).toBe(true);
    expect(h.backends.get('microvm')!.stops.map((s) => s.handle)).toEqual(['fake-1']);
    expect(await rowA(h)).toMatchObject({ state: 'STOPPING' });
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('when the row was replaced meanwhile, the new sandbox is left alone', async () => {
    const h = harness();
    await runCode(req(), h.deps);
    h.backends.get('microvm')!.script.nextRun = { kind: 'no_answer' };
    h.db.hook = (op, input) => {
      if (op === 'update' && String(input.UpdateExpression).includes('#a0') && h.backends.get('microvm')!.calls.some((c) => c.startsWith('run fake-1'))) {
        h.db.hook = undefined;
        h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'READY', handle: 'rival', version: 40, lastUsedAt: h.clock.t }, h.clock.t));
      }
    };
    expect(ok(await runCode(req(), h.deps)).timedOut).toBe(true);
    expect(h.db.hook).toBeUndefined();
    expect(h.backends.get('microvm')!.stops).toEqual([]);
    expect((await rowA(h))?.handle).toBe('rival');
    expect(h.events('sandbox_stopped')).toHaveLength(0);
  });
});
