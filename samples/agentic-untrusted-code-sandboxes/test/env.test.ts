// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ALL_ENV_NAMES, ENV, REGISTRY, registryPk, registrySk } from '../src/env';

describe('env names', () => {
  test('every variable name equals its key, is upper snake case and is unique', () => {
    expect(new Set(ALL_ENV_NAMES).size).toBe(ALL_ENV_NAMES.length);
    for (const name of ALL_ENV_NAMES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    for (const [key, value] of Object.entries(ENV)) expect(value).toBe(key);
  });

  test('registry attribute names are unique', () => {
    const values = Object.values(REGISTRY);
    expect(new Set(values).size).toBe(values.length);
  });

  test('keys follow spec 4.1', () => {
    expect(registryPk('tenant-a')).toBe('TENANT#tenant-a');
    expect(registrySk('nitro')).toBe('SANDBOX#nitro');
  });
});
