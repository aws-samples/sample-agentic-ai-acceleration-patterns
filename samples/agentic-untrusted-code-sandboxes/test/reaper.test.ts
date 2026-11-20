// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { harness, maintenanceDeps, rowItem, seedSandbox, type Harness } from './harness';
import { reapOnce } from '../src/reaper/reaper';
import { runCode } from '../src/tool/run-code';

const A = 'tenant-a';
const B = 'tenant-b';
const HOUR = 3_600_000;
const row = (h: Harness, tenant = A, backend: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => h.registry.get(tenant, backend);
const stops = (h: Harness, b: 'microvm' | 'nitro' | 'agentcore' = 'microvm') => h.backends.get(b)!.stops.map((s) => s.handle);

describe('rows', () => {
  test('a nitro row idle past sandboxIdle is set STOPPING, stopped, and gets one line; a microvm row is not touched for idleness', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro');
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', B);
    h.clock.t += 900_001;
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary).toMatchObject({ rows: 2, stopped: 1, errors: 0 });
    expect(await row(h, A, 'nitro')).toMatchObject({ state: 'STOPPING' });
    expect(await row(h, B, 'microvm')).toMatchObject({ state: 'READY' });
    expect(stops(h, 'nitro')).toEqual(['fake-1']);
    expect(stops(h, 'microvm')).toEqual([]);
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ tenantId: A, backend: 'nitro', by: 'reaper', reason: 'idle' })]);
  });

  test('idle is measured from lastUsedAt, and a row used inside the window is left alone', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro');
    h.clock.t += 900_000;
    await reapOnce(maintenanceDeps(h));
    expect(stops(h, 'nitro')).toEqual([]);
    h.clock.t += 1;
    await reapOnce(maintenanceDeps(h));
    expect(stops(h, 'nitro')).toEqual(['fake-1']);
  });

  test('a READY row whose platform sandbox is gone is deleted, with the line', async () => {
    const h = harness();
    const handle = await seedSandbox(h, 'READY');
    h.backends.get('microvm')!.kill(handle.handle);
    h.clock.t += 60_000;
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary).toMatchObject({ deletedRows: 1, stopped: 0 });
    expect(await row(h)).toBeUndefined();
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ handle: 'fake-1', reason: 'gone', by: 'reaper', tenantId: A })]);
    expect(h.backends.get('microvm')!.stops).toEqual([]);
  });

  test('a live READY row is left alone', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    h.clock.t += 60_000;
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toMatchObject({ state: 'READY', version: 5 });
    expect(h.lines.filter((l) => l.event === 'sandbox_stopped')).toEqual([]);
  });

  test('a READY row past expiresAt is stopped, lined once, and deleted', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    h.clock.t += 8 * HOUR;
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary).toMatchObject({ stopped: 1, deletedRows: 1 });
    expect(await row(h)).toBeUndefined();
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ reason: 'expired', sandboxSeconds: 8 * 3600 })]);
    expect(stops(h)).toEqual(['fake-1']);
  });

  test.each(['FAILED', 'STOPPING'] as const)('an expired %s row is deleted with no new line', async (state) => {
    const h = harness();
    const handle = await seedSandbox(h, state, { retryAt: h.clock.t });
    h.backends.get('microvm')!.kill(handle.handle);
    h.clock.t += 8 * HOUR;
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toBeUndefined();
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('an expired handle-less STARTING row is deleted', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t }, h.clock.t));
    h.clock.t += 8 * HOUR;
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toBeUndefined();
  });

  test.each(['FAILED', 'STOPPING'] as const)('a %s row whose sandbox the platform still lists is stopped again, with no line', async (state) => {
    const h = harness();
    await seedSandbox(h, state, { retryAt: h.clock.t + 1000 });
    await reapOnce(maintenanceDeps(h));
    expect(stops(h)).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')).toEqual([]);
    expect(await row(h)).toMatchObject({ state });
  });

  test('a task older than sandboxMaxLife by its own startedAt is stopped though its row is not yet expired', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t + 8 * HOUR - 10, expiresAt: h.clock.t + 9 * HOUR }, 'nitro');
    h.clock.t += 8 * HOUR;
    await reapOnce(maintenanceDeps(h));
    expect(stops(h, 'nitro')).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ reason: 'expired' });
  });

  test('a row for a backend that is not deployed is left alone', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'nitro', state: 'READY', handle: 'x', createdAt: h.clock.t - 9 * HOUR, expiresAt: h.clock.t - HOUR }, h.clock.t));
    await reapOnce(maintenanceDeps(h));
    expect(h.db.row('TENANT#tenant-a', 'SANDBOX#nitro')).toBeDefined();
  });

  test('a row the tool updated between the scan and the write is left to the tool: no stop, no line', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro');
    h.clock.t += 901_000;
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#nitro')!;
        item.version = 6;
        item.lastUsedAt = h.clock.t;
      }
    };
    await reapOnce(maintenanceDeps(h));
    expect(stops(h, 'nitro')).toEqual([]);
    expect(h.events('sandbox_stopped')).toEqual([]);
    expect(await row(h, A, 'nitro')).toMatchObject({ state: 'READY' });
  });

  test('pages through a table larger than one scan page', async () => {
    const h = harness();
    h.db.pageSize = 2;
    for (let i = 0; i < 5; i++) await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', `t${i}`);
    h.clock.t += 8 * HOUR;
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary).toMatchObject({ rows: 5, stopped: 5, deletedRows: 5 });
  });
});

describe('starts', () => {
  test('a STARTING row whose sandbox ended is FAILED and lined with the platform reason, with no stop call', async () => {
    const h = harness();
    const handle = await seedSandbox(h, 'STARTING');
    h.backends.get('microvm')!.kill(handle.handle);
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toMatchObject({ state: 'FAILED', retryAt: h.clock.t + 30_000, handle: handle.handle });
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ reason: 'failed_start', stoppedReason: 'stopped', by: 'reaper' })]);
    expect(stops(h)).toEqual([]);
  });

  test('the reaper never calls ready: that probe is the tool\'s and needs more than the reaper role has', async () => {
    const h = harness();
    await seedSandbox(h, 'STARTING', { leaseUntil: h.clock.t - 1 });
    const ready = jest.spyOn(h.backends.get('microvm')!, 'ready');
    await reapOnce(maintenanceDeps(h));
    expect(ready).not.toHaveBeenCalled();
  });

  test('a STARTING row past its lease and not ready is FAILED with start_cap', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 100;
    await seedSandbox(h, 'STARTING', { leaseUntil: h.clock.t - 1 });
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary.failedStarts).toBe(1);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ stoppedReason: 'start_cap' });
  });

  test('a STARTING row still inside its lease is left alone', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 100;
    await seedSandbox(h, 'STARTING');
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toMatchObject({ state: 'STARTING', version: 5 });
    expect(stops(h)).toEqual([]);
  });

  test('a STARTING row inside its lease is left alone even when its sandbox is ready', async () => {
    const h = harness();
    await seedSandbox(h, 'STARTING');
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toMatchObject({ state: 'STARTING', version: 5 });
  });

  test('a STARTING row nobody came back to is stopped when its lease runs out, so a ready sandbox is never left to run until sandboxMaxLife', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'STARTING', { leaseUntil: h.clock.t + 300_000 }, 'nitro');
    h.clock.t += 7 * HOUR;
    await reapOnce(maintenanceDeps(h));
    expect(stops(h, 'nitro')).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ reason: 'failed_start', stoppedReason: 'start_cap' });
  });
});

describe('orphans', () => {
  test('a live nitro task no row names is stopped, lined as an orphan with its tenant tag', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await h.backends.get('nitro')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.clock.t += 120_000;
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary.orphans).toBe(1);
    expect(stops(h, 'nitro')).toEqual(['fake-1']);
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ tenantId: B, orphan: true, reason: 'orphan', sandboxSeconds: 120 })]);
  });

  test('a microvm orphan has tenant "unknown"', async () => {
    const h = harness();
    await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    await reapOnce(maintenanceDeps(h));
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ tenantId: 'unknown', orphan: true });
  });

  test('a sandbox a row names is not an orphan, whatever the row state', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', A);
    await seedSandbox(h, 'FAILED', { retryAt: h.clock.t + 1000 }, 'microvm', B);
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary.orphans).toBe(0);
  });

  test('a stopped sandbox is not listed live, so it is not an orphan', async () => {
    const h = harness();
    const handle = await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.backends.get('microvm')!.kill(handle.handle);
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(0);
  });

  test('while a start of the same backend is between its takeover and its handle, nothing is swept (the tool is mid-start)', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await h.backends.get('nitro')!.start(A, 'A'.repeat(43), { tenantId: A, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.db.seed(rowItem({ tenantId: A, backend: 'nitro', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 300_000, version: 2 }, h.clock.t));
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(0);
    expect(stops(h, 'nitro')).toEqual([]);
    // a handle-less row that is old has no start in flight: the sandbox is an orphan
    h.clock.t += 10 * 60_000;
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(1);
  });

  test('a sandbox started before the in-flight start\'s row was written is not shielded: it is an orphan', async () => {
    const h = harness();
    await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.clock.t += 60_000;
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 20_000 }, h.clock.t));
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(1);
    // one started after that row, and one with no start time, are shielded
    await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.clock.t += 1000;
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(0);
  });

  test('a start in flight for one tenant does not shield another tenant\'s orphan on nitro', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await h.backends.get('nitro')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.db.seed(rowItem({ tenantId: A, backend: 'nitro', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 300_000 }, h.clock.t));
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(1);
  });

  test('a start in flight on microvm shields every unlabelled sandbox of that backend', async () => {
    const h = harness();
    await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t, leaseUntil: h.clock.t + 20_000 }, h.clock.t));
    expect((await reapOnce(maintenanceDeps(h))).orphans).toBe(0);
  });

  test('agentcore lists nothing, so there is nothing to sweep', async () => {
    const h = harness({ backends: ['agentcore'], defaultBackend: 'agentcore' });
    await runCode({ tenantId: A, code: 'x' }, h.deps);
    jest.spyOn(h.backends.get('agentcore')!, 'list').mockImplementation(async function* () { /* none */ });
    const summary = await reapOnce(maintenanceDeps(h));
    expect(summary).toMatchObject({ orphans: 0, errors: 0 });
  });
});

describe('a pass', () => {
  test('is idempotent: the second pass over the same state stops nothing and writes no second line', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro', A);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', B);
    const dead = await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', 'tenant-c');
    h.backends.get('microvm')!.kill(dead.handle);
    await h.backends.get('nitro')!.start('tenant-d', 'A'.repeat(43), { tenantId: 'tenant-d', accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.clock.t += 8 * HOUR;
    await reapOnce(maintenanceDeps(h));
    const linesAfterFirst = h.events('sandbox_stopped').length;
    const stopCalls = [...stops(h, 'nitro'), ...stops(h, 'microvm')].length;
    expect(linesAfterFirst).toBe(4);
    const second = await reapOnce(maintenanceDeps(h));
    expect(second).toMatchObject({ stopped: 0, deletedRows: 0, orphans: 0, errors: 0 });
    expect(h.events('sandbox_stopped')).toHaveLength(linesAfterFirst);
    expect([...stops(h, 'nitro'), ...stops(h, 'microvm')]).toHaveLength(stopCalls);
    expect(h.db.items.size).toBe(0);
  });

  test('an orphan whose stop fails gets no line and is not counted, and the next pass stops it and writes its one line', async () => {
    const h = harness();
    await h.backends.get('microvm')!.start(B, 'A'.repeat(43), { tenantId: B, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    const b = h.backends.get('microvm')!;
    const realStop = b.stop.bind(b);
    const failing = jest.spyOn(b, 'stop').mockRejectedValue(new Error('throttled'));
    for (let i = 0; i < 3; i++) expect(await reapOnce(maintenanceDeps(h))).toMatchObject({ stopped: 0, orphans: 0 });
    expect(h.events('sandbox_stopped')).toEqual([]);
    failing.mockImplementation(realStop);
    expect(await reapOnce(maintenanceDeps(h))).toMatchObject({ stopped: 1, orphans: 1 });
    await reapOnce(maintenanceDeps(h));
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('an expired row whose stop fails keeps its STOPPING row so the next pass stops it again, then deletes it', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    h.clock.t += 8 * HOUR;
    const b = h.backends.get('microvm')!;
    const realStop = b.stop.bind(b);
    const failing = jest.spyOn(b, 'stop').mockRejectedValue(new Error('throttled'));
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toMatchObject({ state: 'STOPPING' });
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    failing.mockImplementation(realStop);
    await reapOnce(maintenanceDeps(h));
    expect(await row(h)).toBeUndefined();
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('one pass logs its totals', async () => {
    const h = harness();
    await reapOnce(maintenanceDeps(h));
    expect(h.events('reaper')).toEqual([expect.objectContaining({ rows: 0, stopped: 0, errors: 0 })]);
  });

  test('a backend whose list fails is reported, its rows are still handled, and the pass fails at the end', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', A);
    h.clock.t += 8 * HOUR;
    jest.spyOn(h.backends.get('nitro')!, 'list').mockImplementation(() => { throw new TypeError('x'); });
    await expect(reapOnce(maintenanceDeps(h))).rejects.toThrow(/1 error/);
    expect(h.events('reaper_error')).toEqual([expect.objectContaining({ what: 'list', backend: 'nitro', error: 'TypeError' })]);
    expect(await row(h)).toBeUndefined();
  });

  test('a row whose stop throws does not block the others', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', A);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', B);
    h.clock.t += 8 * HOUR;
    const b = h.backends.get('microvm')!;
    const realStop = b.stop.bind(b);
    let first = true;
    jest.spyOn(b, 'stop').mockImplementation(async (handle, creds) => {
      if (first) {
        first = false;
        throw new Error('throttled');
      }
      return realStop(handle, creds);
    });
    await reapOnce(maintenanceDeps(h));
    expect(h.events('stop_failed')).toHaveLength(1);
    expect(h.events('sandbox_stopped')).toHaveLength(2);
  });
});
