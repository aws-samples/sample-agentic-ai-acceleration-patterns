// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { harness, maintenanceDeps, rowItem, seedSandbox, type Harness } from './harness';
import { drain, DRAIN_BOUND_MS } from '../src/drain/drain';
import { handler } from '../src/drain/drain.function';
import { ENV } from '../src/env';

// The entry builds its deps from the environment; the test swaps the AWS-facing builders for the in-memory ones.
const mockWired: { h?: Harness } = {};
jest.mock('../src/tool/deps', () => ({
  loadBackends: () => mockWired.h?.backends,
  registryClient: () => mockWired.h?.registry,
}));

const A = 'tenant-a';
const B = 'tenant-b';

function deps(h: Harness) {
  return { ...maintenanceDeps(h), sleep: h.clock.sleep };
}

/** Makes a backend's sandboxes take `ms` of clock time to end after their stop, as a task does. */
function slowStop(h: Harness, name: 'microvm' | 'nitro' | 'agentcore', ms: number) {
  const b = h.backends.get(name)!;
  const pending = new Map<string, number>();
  jest.spyOn(b, 'stop').mockImplementation(async (handle) => {
    if (!pending.has(handle.handle)) pending.set(handle.handle, h.clock.t + ms);
  });
  const realList = b.list.bind(b);
  jest.spyOn(b, 'list').mockImplementation(async function* () {
    for (const [handle, at] of pending) if (h.clock.t >= at) b.kill(handle);
    yield* realList();
  });
  return pending;
}

describe('the drain', () => {
  test('stops every sandbox a row names, with one line each from the drain, and every orphan', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'microvm', A);
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t }, 'nitro', B);
    await seedSandbox(h, 'FAILED', { retryAt: h.clock.t }, 'microvm', 'tenant-c');
    await h.backends.get('nitro')!.start('tenant-d', 'A'.repeat(43), { tenantId: 'tenant-d', accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    const out = await drain(deps(h));
    expect(out).toEqual({ rowsStopped: 2, orphansStopped: 1 });
    for (const b of h.backends.values()) expect([...b.sandboxes.values()].every((s) => !s.live)).toBe(true);
    const lines = h.events('sandbox_stopped');
    expect(lines.map((l) => [l.tenantId, l.reason, l.orphan === true, l.by])).toEqual([
      [A, 'drain', false, 'drain'], [B, 'drain', false, 'drain'], ['tenant-d', 'orphan', true, 'drain'],
    ]);
  });

  test('a sandbox with a FAILED or STOPPING row is stopped but earns no second line', async () => {
    const h = harness();
    await seedSandbox(h, 'STOPPING');
    await drain(deps(h));
    expect(h.backends.get('microvm')!.sandboxes.get('fake-1')!.live).toBe(false);
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('waits until the platform lists none live, polling, and stops a straggler again after a minute', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', {}, 'nitro');
    const pending = slowStop(h, 'nitro', 90_000);
    const began = h.clock.t;
    await drain(deps(h));
    expect(h.clock.t - began).toBeGreaterThanOrEqual(90_000);
    expect(h.clock.t - began).toBeLessThan(100_000);
    expect(pending.size).toBe(1);
    // first stop, then a second one after RESTOP_MS (60 s) while it was still listed
    expect(h.backends.get('nitro')!.stop).toHaveBeenCalledTimes(2);
  });

  test('fails loudly when a sandbox is still live at the bound, and never runs cleanup', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', {}, 'nitro');
    jest.spyOn(h.backends.get('nitro')!, 'stop').mockResolvedValue();
    const cleanup = jest.fn();
    h.backends.get('nitro')!.cleanup = cleanup;
    const began = h.clock.t;
    await expect(drain(deps(h))).rejects.toThrow(/1 sandbox\(es\) still live at the deadline/);
    expect(h.clock.t - began).toBeLessThanOrEqual(DRAIN_BOUND_MS);
    expect(h.clock.t - began).toBeGreaterThan(DRAIN_BOUND_MS - 6000);
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('the Lambda\'s own remaining time shortens the bound', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', {}, 'nitro');
    jest.spyOn(h.backends.get('nitro')!, 'stop').mockResolvedValue();
    const began = h.clock.t;
    await expect(drain(deps(h), began + 20_000)).rejects.toThrow(/still live/);
    expect(h.clock.t - began).toBeLessThanOrEqual(20_000);
  });

  test('runs each backend\'s cleanup after every sandbox is gone, with a deadline', async () => {
    const h = harness({ backends: ['microvm', 'nitro'] });
    await seedSandbox(h, 'READY', {}, 'nitro');
    const order: string[] = [];
    const nitro = h.backends.get('nitro')!;
    jest.spyOn(nitro, 'stop').mockImplementation(async (handle) => {
      order.push('stop');
      nitro.kill(handle.handle);
    });
    nitro.cleanup = jest.fn(async (deadline: number) => {
      order.push(`cleanup ${deadline - h.clock.t}`);
    });
    await drain(deps(h));
    expect(order).toEqual(['stop', `cleanup ${DRAIN_BOUND_MS}`]);
    expect(h.backends.get('microvm')!.cleanup).toBeUndefined();
  });

  test('a registry table that is already gone is no rows; the sweep still runs', async () => {
    const h = harness();
    await h.backends.get('microvm')!.start(A, 'A'.repeat(43), { tenantId: A, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    h.db.hook = (op) => {
      if (op === 'scan') {
        const e = new Error('gone');
        e.name = 'ResourceNotFoundException';
        throw e;
      }
    };
    expect(await drain(deps(h))).toEqual({ rowsStopped: 0, orphansStopped: 1 });
    expect(h.events('drain_registry_gone')).toHaveLength(1);
  });

  test('any other registry error stops the drain', async () => {
    const h = harness();
    h.db.hook = (op) => {
      if (op === 'scan') throw new Error('AccessDenied');
    };
    await expect(drain(deps(h))).rejects.toThrow('AccessDenied');
  });

  test('with nothing running it finishes at once and logs its totals', async () => {
    const h = harness();
    expect(await drain(deps(h))).toEqual({ rowsStopped: 0, orphansStopped: 0 });
    expect(h.events('drain')).toEqual([expect.objectContaining({ rowsStopped: 0, orphansStopped: 0 })]);
    expect(h.clock.t).toBe(1_700_000_000_000);
  });

  test('a row a call updated first is read again, moved, stopped and lined once by the drain', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version = 9;
      }
    };
    const out = await drain(deps(h));
    expect(out).toEqual({ rowsStopped: 1, orphansStopped: 0 });
    expect(h.backends.get('microvm')!.sandboxes.get('fake-1')!.live).toBe(false);
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ handle: 'fake-1', by: 'drain', reason: 'drain' })]);
  });

  test('a row replaced while the drain moves it is stopped, and its line is left to the call that replaced it', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        // the tool took the row over: a new nonce, no handle, and the old handle named as replaced
        h.db.seed(rowItem({ tenantId: A, backend: 'microvm', state: 'STARTING', createdAt: h.clock.t, version: 6 }, h.clock.t));
        h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.replaces = 'fake-1';
      }
    };
    expect(await drain(deps(h))).toEqual({ rowsStopped: 0, orphansStopped: 0 });
    expect(h.backends.get('microvm')!.sandboxes.get('fake-1')!.live).toBe(false);
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('a row the drain moved ends STOPPING', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version = 9;
      }
    };
    await drain(deps(h));
    expect(await h.registry.get(A, 'microvm')).toMatchObject({ state: 'STOPPING', version: 10 });
  });

  test('a row another writer already moved to STOPPING keeps that writer\'s line: the drain writes none', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        const item = h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!;
        item.version = 9;
        item.state = 'STOPPING';
      }
    };
    expect(await drain(deps(h))).toEqual({ rowsStopped: 0, orphansStopped: 0 });
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('a sandbox a takeover replaced is stopped by the drain, and the drain writes its line when the call died before it did', async () => {
    const h = harness();
    const old = await seedSandbox(h, 'READY');
    const prev = (await h.registry.get(A, 'microvm'))!;
    await h.registry.takeOver({
      tenantId: A, backend: 'microvm', nonce: 'B'.repeat(43), now: h.clock.t, startCapMs: 20_000, sandboxMaxLifeMs: 3_600_000, replaces: old.handle,
    }, prev);
    h.clock.t += 120_000;
    await drain(deps(h));
    expect(h.backends.get('microvm')!.sandboxes.get(old.handle)!.live).toBe(false);
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ handle: old.handle, by: 'drain', reason: 'replaced' })]);
  });

  test('a replaced sandbox of a call still in flight is stopped with no line from the drain', async () => {
    const h = harness();
    const old = await seedSandbox(h, 'READY');
    const prev = (await h.registry.get(A, 'microvm'))!;
    await h.registry.takeOver({
      tenantId: A, backend: 'microvm', nonce: 'B'.repeat(43), now: h.clock.t, startCapMs: 20_000, sandboxMaxLifeMs: 3_600_000, replaces: old.handle,
    }, prev);
    await drain(deps(h));
    expect(h.backends.get('microvm')!.sandboxes.get(old.handle)!.live).toBe(false);
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('a sandbox a takeover replaced that stays listed after its stop is not lined as an orphan', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    const old = await seedSandbox(h, 'READY', {}, 'nitro');
    const prev = (await h.registry.get(A, 'nitro'))!;
    await h.registry.takeOver({
      tenantId: A, backend: 'nitro', nonce: 'B'.repeat(43), now: h.clock.t, startCapMs: 20_000, sandboxMaxLifeMs: 3_600_000, replaces: old.handle,
    }, prev);
    h.db.row('TENANT#tenant-a', 'SANDBOX#nitro')!.replacesLined = true;
    const pending = slowStop(h, 'nitro', 20_000);
    await drain(deps(h));
    expect(pending.size).toBe(1);
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('a row replaced while the drain moves it, whose sandbox stays listed, is not lined as an orphan either', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', {}, 'nitro');
    h.db.hook = (op) => {
      if (op === 'update') {
        h.db.hook = undefined;
        h.db.seed(rowItem({ tenantId: B, backend: 'nitro', state: 'STARTING', createdAt: h.clock.t, version: 6 }, h.clock.t));
        h.db.items.delete('TENANT#tenant-a|SANDBOX#nitro');
      }
    };
    const pending = slowStop(h, 'nitro', 20_000);
    await drain(deps(h));
    expect(pending.size).toBe(1);
    expect(h.events('sandbox_stopped')).toEqual([]);
  });

  test('a row that keeps changing, whose stop fails, is lined once a stop works and not before', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version = (h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version as number) + 1;
    };
    const b = h.backends.get('microvm')!;
    const real = b.stop.bind(b);
    let fail = true;
    const seen: number[] = [];
    jest.spyOn(b, 'stop').mockImplementation(async (handle, creds) => {
      seen.push(h.events('sandbox_stopped').length);
      if (fail) {
        fail = false;
        throw new Error('throttled');
      }
      return real(handle, creds);
    });
    await drain(deps(h));
    expect(seen[0]).toBe(0);
    expect(h.events('sandbox_stopped')).toHaveLength(1);
  });

  test('cleanup gets a deadline no later than the Lambda\'s limit', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    const cleanup = jest.fn();
    h.backends.get('nitro')!.cleanup = cleanup;
    const began = h.clock.t;
    await drain(deps(h), began + 100_000);
    expect(cleanup).toHaveBeenCalledWith(began + 100_000);
  });

  test('a row that keeps changing still gets its one line, from the drain, once the sandbox is stopped', async () => {
    const h = harness();
    await seedSandbox(h, 'READY');
    h.db.hook = (op) => {
      if (op === 'update') h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version = (h.db.row('TENANT#tenant-a', 'SANDBOX#microvm')!.version as number) + 1;
    };
    const out = await drain(deps(h));
    expect(out).toEqual({ rowsStopped: 1, orphansStopped: 0 });
    expect(h.events('sandbox_stopped')).toEqual([expect.objectContaining({ handle: 'fake-1', by: 'drain', reason: 'drain' })]);
  });

  test('an orphan whose stop fails gets its line only once a stop works', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await h.backends.get('nitro')!.start(A, 'A'.repeat(43), { tenantId: A, accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' });
    const b = h.backends.get('nitro')!;
    const realStop = b.stop.bind(b);
    let failures = 2;
    const linesAtAttempt: number[] = [];
    jest.spyOn(b, 'stop').mockImplementation(async (handle, creds) => {
      linesAtAttempt.push(h.events('sandbox_stopped').length);
      if (failures-- > 0) throw new Error('throttled');
      return realStop(handle, creds);
    });
    await drain(deps(h));
    expect(h.events('sandbox_stopped')).toHaveLength(1);
    expect(h.events('stop_failed')).toHaveLength(2);
    expect(linesAtAttempt).toEqual([0, 0, 0]);
  });
});

describe('the custom resource entry', () => {
  test.each(['Create', 'Update'] as const)('%s does nothing and returns the physical id', async (RequestType) => {
    await expect(handler({ RequestType })).resolves.toEqual({ PhysicalResourceId: 'untrusted-code-sandboxes-drain' });
    await expect(handler({ RequestType, PhysicalResourceId: 'kept' })).resolves.toEqual({ PhysicalResourceId: 'kept' });
  });
});

describe('the custom resource entry on Delete', () => {
  const env = {
    [ENV.REGISTRY_TABLE]: 'registry',
    [ENV.INPUT_BUCKET]: 'b',
    [ENV.BACKENDS]: 'microvm',
    [ENV.DEFAULT_BACKEND]: 'microvm',
    [ENV.TOOL_TENANT_ROLE_ARN]: 'arn',
    [ENV.RUN_TIMEOUT_MS]: '30000',
    [ENV.START_WAIT_MS]: '15000',
    [ENV.MAX_OUTPUT_BYTES]: '1',
    [ENV.MAX_INPUT_BYTES]: '1',
    [ENV.SANDBOX_IDLE_MS]: '900000',
    [ENV.SANDBOX_MAX_LIFE_MS]: '28800000',
  };
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => {
    process.env = { ...saved };
  });

  test('stops every sandbox, echoes the physical id, and writes the totals line', async () => {
    const h = harness();
    mockWired.h = h;
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t });
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(handler({ RequestType: 'Delete', PhysicalResourceId: 'drain-1' }, { getRemainingTimeInMillis: () => 900_000 }))
        .resolves.toEqual({ PhysicalResourceId: 'drain-1' });
    } finally {
      out.mockRestore();
    }
    expect(h.backends.get('microvm')!.sandboxes.get('fake-1')!.live).toBe(false);
  });

  test('fails the resource when a sandbox is still live at the Lambda\'s own limit', async () => {
    const h = harness();
    mockWired.h = h;
    await seedSandbox(h, 'READY');
    jest.spyOn(h.backends.get('microvm')!, 'stop').mockResolvedValue();
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // 30 s margin is kept back, so 30 s of remaining time leaves no time to wait at all
      await expect(handler({ RequestType: 'Delete' }, { getRemainingTimeInMillis: () => 30_000 })).rejects.toThrow(/still live at the deadline/);
    } finally {
      out.mockRestore();
    }
  });
});
