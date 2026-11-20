// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { harness, maintenanceDeps, rowItem, seedSandbox } from './harness';
import { offboardTenant } from '../src/offboard/offboard';
import { handler } from '../src/offboard/offboard.function';
import { runCode } from '../src/tool/run-code';

const A = 'tenant-a';
const B = 'tenant-b';

describe('offboardTenant', () => {
  test("stops one tenant's sandboxes on every backend, deletes its rows, and leaves the other tenant running", async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', A);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro', A);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', B);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro', B);
    const out = await offboardTenant(A, maintenanceDeps(h));
    expect(out).toEqual({ tenantId: A, stopped: [{ backend: 'microvm', handle: 'fake-1' }, { backend: 'nitro', handle: 'fake-1' }] });
    expect(await h.registry.get(A, 'microvm')).toBeUndefined();
    expect(await h.registry.get(A, 'nitro')).toBeUndefined();
    expect(await h.registry.get(B, 'microvm')).toMatchObject({ state: 'READY', handle: 'fake-2' });
    expect(await h.registry.get(B, 'nitro')).toMatchObject({ state: 'READY', handle: 'fake-2' });
    expect(h.backends.get('microvm')!.sandboxes.get('fake-1')!.live).toBe(false);
    expect(h.backends.get('microvm')!.sandboxes.get('fake-2')!.live).toBe(true);
    expect(h.backends.get('nitro')!.sandboxes.get('fake-2')!.live).toBe(true);
    const lines = h.events('sandbox_stopped');
    expect(lines.map((l) => [l.tenantId, l.backend, l.by, l.reason])).toEqual([[A, 'microvm', 'offboard', 'offboard'], [A, 'nitro', 'offboard', 'offboard']]);
  });

  test('is idempotent: a repeat finds no rows, stops nothing, writes no line, and returns the same shape', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    await offboardTenant(A, maintenanceDeps(h));
    const stopCalls = h.backends.get('microvm')!.stops.length;
    const again = await offboardTenant(A, maintenanceDeps(h));
    expect(again).toEqual({ tenantId: A, stopped: [] });
    expect(h.backends.get('microvm')!.stops).toHaveLength(stopCalls);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('stops a STARTING sandbox the same way', async () => {
    const h = harness();
    h.backends.get('microvm')!.script.startingProbes = 100;
    await seedSandbox(h, 'STARTING');
    expect((await offboardTenant(A, maintenanceDeps(h))).stopped).toEqual([{ backend: 'microvm', handle: 'fake-1' }]);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('a handle-less row is deleted and nothing is stopped', async () => {
    const h = harness();
    h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t }, h.clock.t));
    expect(await offboardTenant(A, maintenanceDeps(h))).toEqual({ tenantId: A, stopped: [] });
    expect(h.db.items.size).toBe(0);
  });

  test.each(['FAILED', 'STOPPING'] as const)('a %s row whose sandbox is still alive is stopped again, with no new line', async (state) => {
    const h = harness();
    await seedSandbox(h, state, { retryAt: h.clock.t + 1000 });
    expect((await offboardTenant(A, maintenanceDeps(h))).stopped).toHaveLength(1);
    expect(h.events('sandbox_stopped')).toEqual([]);
    expect(h.db.items.size).toBe(0);
  });

  test.each(['FAILED', 'STOPPING'] as const)('a %s row whose sandbox is already gone is only deleted', async (state) => {
    const h = harness();
    const handle = await seedSandbox(h, state, { retryAt: h.clock.t + 1000 });
    h.backends.get('microvm')!.kill(handle.handle);
    expect(await offboardTenant(A, maintenanceDeps(h))).toEqual({ tenantId: A, stopped: [] });
    expect(h.db.items.size).toBe(0);
  });

  test('does not touch a tenant whose id shares a prefix', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', {}, 'microvm', 'tenant-a');
    await seedSandbox(h, 'READY', {}, 'microvm', 'tenant-a2');
    await seedSandbox(h, 'READY', {}, 'microvm', 'tenant-');
    await offboardTenant('tenant-a', maintenanceDeps(h));
    expect(await h.registry.get('tenant-a2', 'microvm')).toMatchObject({ state: 'READY' });
    expect(await h.registry.get('tenant-', 'microvm')).toMatchObject({ state: 'READY' });
  });

  test('runs with the reaper role: the stop carries no tenant credentials', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', {}, 'nitro');
    await offboardTenant(A, maintenanceDeps(h));
    expect(h.backends.get('nitro')!.stops).toEqual([{ handle: 'fake-1', creds: undefined }]);
  });

  test('a call that updates the row between the read and the write wins; the offboard reads again and then stops', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    let bumps = 0;
    h.db.hook = (op) => {
      if (op === 'update' && bumps < 2) {
        bumps += 1;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 1;
      }
    };
    const out = await offboardTenant(A, maintenanceDeps(h));
    expect(bumps).toBe(2);
    expect(out.stopped).toEqual([{ backend: 'microvm', handle: 'fake-1' }]);
    expect(h.db.items.size).toBe(0);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('a row that keeps changing is given up on after a few reads, without a stop, and the call fails so the caller repeats it', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    h.db.hook = (op) => {
      if (op === 'update') {
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 1;
      }
    };
    await expect(offboardTenant(A, maintenanceDeps(h))).rejects.toThrow(/1 sandbox\(es\) or row\(s\) could not be cleared/);
    expect(h.backends.get('microvm')!.stops).toEqual([]);
    expect(h.db.items.size).toBe(1);
    h.db.hook = undefined;
    expect((await offboardTenant(A, maintenanceDeps(h))).stopped).toEqual([{ backend: 'microvm', handle: 'fake-1' }]);
  });

  test('a stop that fails keeps the row (STOPPING) for the reaper and fails the call', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', {}, 'microvm', A);
    await seedSandbox(h, 'READY', {}, 'nitro', A);
    jest.spyOn(h.backends.get('microvm')!, 'stop').mockRejectedValue(new Error('x'));
    await expect(offboardTenant(A, maintenanceDeps(h))).rejects.toThrow(/1 sandbox\(es\) or row\(s\) could not be cleared/);
    expect(await h.registry.get(A, 'microvm')).toMatchObject({ state: 'STOPPING' });
    // the other backend was still handled
    expect(await h.registry.get(A, 'nitro')).toBeUndefined();
  });

  test('a stop that fails reports the sandbox once, and a delete that loses a race does not list a handle twice', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    let raced = false;
    h.db.hook = (op) => {
      if (op === 'delete' && !raced) {
        raced = true;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 1;
      }
    };
    const out = await offboardTenant(A, maintenanceDeps(h));
    expect(raced).toBe(true);
    expect(out.stopped).toEqual([{ backend: 'microvm', handle: 'fake-1' }]);
    expect(h.db.items.size).toBe(0);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('a sandbox that lingers after its stop is stopped again on the repeat read, but listed once', async () => {
    const h = harness();
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    jest.spyOn(h.backends.get('microvm')!, 'isAlive').mockResolvedValue(true);
    let raced = false;
    h.db.hook = (op) => {
      if (op === 'delete' && !raced) {
        raced = true;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = (item.version as number) + 1;
      }
    };
    const out = await offboardTenant(A, maintenanceDeps(h));
    expect(out.stopped).toEqual([{ backend: 'microvm', handle: 'fake-1' }]);
    expect(h.backends.get('microvm')!.stops).toHaveLength(2);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test.each([undefined, null, 5, '', 'a b', 'a#b', '-a', 'a'.repeat(65), { tenantId: A }])('refuses the tenant id %p', async (bad) => {
    const h = harness();
    await seedSandbox(h, 'READY');
    await expect(offboardTenant(bad, maintenanceDeps(h))).rejects.toThrow(/tenantId must match/);
    expect(h.db.items.size).toBe(1);
  });

  test('a tenant that ran code through the tool is stopped and its next call starts fresh', async () => {
    const h = harness();
    await runCode({ tenantId: A, code: 'x' }, h.deps);
    await offboardTenant(A, maintenanceDeps(h));
    const next = await runCode({ tenantId: A, code: 'x' }, h.deps);
    expect(next).toMatchObject({ sandbox: 'started' });
    expect((await h.registry.get(A, 'microvm'))?.handle).toBe('fake-2');
  });
});

describe('the Lambda entry', () => {
  test('refuses an event with no tenantId', async () => {
    await expect(handler(undefined)).rejects.toThrow(/tenantId must match/);
    await expect(handler({})).rejects.toThrow(/tenantId must match/);
  });
});
