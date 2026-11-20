// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The two test hooks of the integration test (ADR-0058, threat T-88): the
// reaper honours `maxLifeSeconds` and the tool passes `failAtBoot` for one
// tenant, both only with RC_INTEG_OVERRIDES=1 on the function.

import { harness } from './harness';
import { TEST_HOOK_ENV, TEST_HOOK_FIELDS } from '../src/env';
import { maxLifeOverrideMs } from '../src/reaper/reaper.function';
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
      expect(h.backends.get('microvm')?.startOptions).toEqual([{ failAtBoot: true }, undefined]);
    });

    test('with the variable off the named tenant starts normally', async () => {
      Object.assign(process.env, on, { [TEST_HOOK_ENV.RC_INTEG_OVERRIDES]: '' });
      const h = harness();
      await runCode({ tenantId: 'tenant-e', code: 'print(1)' }, h.deps);
      expect(h.backends.get('microvm')?.startOptions).toEqual([undefined]);
    });
  });
});
