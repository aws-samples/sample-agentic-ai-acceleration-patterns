// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The two test hooks of the integration test (ADR-0058, threat T-88): the
// reaper honours `maxLifeSeconds` and the tool passes `failAtBoot` for one
// tenant, both only with RC_INTEG_OVERRIDES=1 on the function.

import { harness, maintenanceDeps, seedSandbox } from './harness';
import { TEST_HOOK_ENV, TEST_HOOK_FIELDS } from '../src/env';
import { reapOnce } from '../src/reaper/reaper';
import { maxLifeOverrideMs, passDeps } from '../src/reaper/reaper.function';
import { runCode, startOptions } from '../src/tool/run-code';

const on = { [TEST_HOOK_ENV.RC_INTEG_OVERRIDES]: '1', [TEST_HOOK_ENV.RC_INTEG_FAIL_START_TENANT]: 'tenant-e' };
const event = (seconds: unknown) => ({ [TEST_HOOK_FIELDS.REAPER_MAX_LIFE_SECONDS]: seconds });

describe('the reaper hook', () => {
  test('a positive number of seconds replaces the maximum life when the variable is 1', () => {
    expect(maxLifeOverrideMs(event(60), on)).toBe(60_000);
    expect(maxLifeOverrideMs(event(0.5), on)).toBe(500);
  });

  test('it is ignored without the variable, or with any other value of it', () => {
    expect(maxLifeOverrideMs(event(60), {})).toBeUndefined();
    expect(maxLifeOverrideMs(event(60), { [TEST_HOOK_ENV.RC_INTEG_OVERRIDES]: 'true' })).toBeUndefined();
    expect(maxLifeOverrideMs(event(60), { [TEST_HOOK_ENV.RC_INTEG_OVERRIDES]: '0' })).toBeUndefined();
  });

  test('a missing, zero, negative, infinite or non-number field changes nothing', () => {
    for (const bad of [undefined, 0, -5, Number.POSITIVE_INFINITY, Number.NaN, '60', null, {}]) expect(maxLifeOverrideMs(event(bad), on)).toBeUndefined();
    expect(maxLifeOverrideMs(undefined, on)).toBeUndefined();
    expect(maxLifeOverrideMs(null, on)).toBeUndefined();
    expect(maxLifeOverrideMs({}, on)).toBeUndefined();
  });
});

describe('the reaper pass', () => {
  const stopped = (h: ReturnType<typeof harness>) => h.backends.get('nitro')?.calls.filter((c) => c.startsWith('stop')) ?? [];

  test('an override pass stops a task older than it, and the next pass without it does not', async () => {
    const h = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t, expiresAt: h.clock.t + 9 * 3_600_000 }, 'nitro');
    h.clock.t += 90_000;
    const base = maintenanceDeps(h);
    const before = JSON.stringify(base.config);
    // without the hook the task, 90 s old and in use, stays
    await reapOnce(passDeps(base, event(60), {}));
    expect(stopped(h)).toEqual([]);
    // with it, a life of 60 s expires the task
    await reapOnce(passDeps(base, event(60), on));
    expect(stopped(h)).toHaveLength(1);
    expect(h.events('sandbox_stopped')[0]).toMatchObject({ reason: 'expired' });
    // the shared deps are not changed by the pass
    expect(JSON.stringify(base.config)).toBe(before);
    expect(passDeps(base, event(60), on)).not.toBe(base);
    expect(passDeps(base, event(60), on).config.sandboxMaxLifeMs).toBe(60_000);
    expect(passDeps(base, {}, on)).toBe(base);
  });
});

describe('the tool hook', () => {
  test('only the named tenant, only with the variable on', () => {
    expect(startOptions('tenant-e', on)).toEqual({ failAtBoot: true });
    expect(startOptions('tenant-a', on)).toBeUndefined();
    expect(startOptions('tenant-e', { [TEST_HOOK_ENV.RC_INTEG_FAIL_START_TENANT]: 'tenant-e' })).toBeUndefined();
    expect(startOptions('tenant-e', { ...on, [TEST_HOOK_ENV.RC_INTEG_OVERRIDES]: '0' })).toBeUndefined();
    expect(startOptions('tenant-e', {})).toBeUndefined();
  });

  test('an empty tenant name names nobody', () => {
    expect(startOptions('', { ...on, [TEST_HOOK_ENV.RC_INTEG_FAIL_START_TENANT]: '' })).toBeUndefined();
  });

  describe('through runCode', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    test('the backend gets failAtBoot for the named tenant and nothing for another', async () => {
      Object.assign(process.env, on);
      const h = harness();
      await runCode({ tenantId: 'tenant-e', code: 'print(1)' }, h.deps);
      await runCode({ tenantId: 'tenant-a', code: 'print(1)' }, h.deps);
      // a second call by the named tenant reuses its sandbox: no start, no new entry
      await runCode({ tenantId: 'tenant-e', code: 'print(2)' }, h.deps);
      expect(h.backends.get('microvm')?.startOptions).toEqual([{ failAtBoot: true }, undefined]);
    });

    test('with the variable off the named tenant starts normally', async () => {
      Object.assign(process.env, on);
      delete process.env[TEST_HOOK_ENV.RC_INTEG_OVERRIDES];
      const h = harness();
      await runCode({ tenantId: 'tenant-e', code: 'print(1)' }, h.deps);
      expect(h.backends.get('microvm')?.startOptions).toEqual([undefined]);
    });
  });
});
