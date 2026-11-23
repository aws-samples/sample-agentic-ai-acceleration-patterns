// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The reaper's Lambda entry with the hook of ADR-0058: the handler caches its
// deps once, and a pass with `maxLifeSeconds` must not change them for the
// pass after it.

import { harness, seedSandbox } from './harness';
import { TEST_HOOK_ENV, TEST_HOOK_FIELDS } from '../src/env';
import { handler } from '../src/reaper/reaper.function';

let mockHarness: ReturnType<typeof harness>;
jest.mock('../src/tool/config', () => ({ ...jest.requireActual('../src/tool/config'), loadConfig: () => mockHarness.deps.config }));
jest.mock('../src/tool/deps', () => ({
  ...jest.requireActual('../src/tool/deps'),
  loadBackends: () => mockHarness.backends,
  registryClient: () => mockHarness.registry,
}));

describe('the reaper handler', () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env = { ...saved };
  });

  test('an override pass expires a 90 s old task, and the next pass, with no override, leaves a task of that age', async () => {
    process.env[TEST_HOOK_ENV.RC_INTEG_OVERRIDES] = '1';
    mockHarness = harness({ backends: ['nitro'], defaultBackend: 'nitro' });
    const h = mockHarness;
    const stops = () => h.backends.get('nitro')?.calls.filter((c) => c.startsWith('stop')).length ?? 0;
    // The handler reads the real clock, so the sandbox is seeded as started 90 s ago by it.
    const seedAged = async () => {
      h.clock.t = Date.now() - 90_000;
      await seedSandbox(h, 'READY', { lastUsedAt: h.clock.t, expiresAt: h.clock.t + 9 * 3_600_000 }, 'nitro');
    };
    await seedAged();
    await handler({});
    expect(stops()).toBe(0);
    await handler({ [TEST_HOOK_FIELDS.REAPER_MAX_LIFE_SECONDS]: 60 });
    expect(stops()).toBe(1);
    await seedAged();
    await handler({});
    expect(stops()).toBe(1);
  });
});
