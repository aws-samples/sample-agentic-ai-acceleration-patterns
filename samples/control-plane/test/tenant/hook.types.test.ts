// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  APPLICATION_SCRIPT_PATH_PATTERN,
  APPLICATION_SOURCE_LOCATION_PATTERN,
  HOOK_ENV_VARS,
  HOOK_FORBIDDEN_ENV_VARS,
  HOOK_ID_PATTERN,
  HOOK_ROLE_KIND_BY_SCOPE,
  HOOK_SCOPES,
  HOOK_SCRIPT_PATH_PATTERN,
  HOOK_SOURCE_LOCATION_PATTERN,
  HOOK_SOURCE_VERSION_PATTERN,
  SCRIPT_OUTPUT_GUARD_PATTERN,
  SCRIPT_OUTPUTS_MAX_BYTES,
} from '../../src/tenant/hook.types';

describe('hook charsets (R-39, §4.1, §4.8)', () => {
  test('hookId is [a-z0-9-]{1,32}', () => {
    expect(HOOK_ID_PATTERN.test('route-registrar-1')).toBe(true);
    expect(HOOK_ID_PATTERN.test('x'.repeat(32))).toBe(true);
    for (const bad of ['', 'x'.repeat(33), 'Upper', 'under_score', 'a\n']) {
      expect(HOOK_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  test('a location admits URL characters without userinfo or control characters', () => {
    expect(HOOK_SOURCE_LOCATION_PATTERN.test('https://github.com/acme/hooks.git')).toBe(true);
    expect(HOOK_SOURCE_LOCATION_PATTERN.test('my-bucket/hooks/v1.zip')).toBe(true);
    for (const bad of ['https://user:token@host/repo', 'https://host/a b', 'https://host/\n', '']) {
      expect(HOOK_SOURCE_LOCATION_PATTERN.test(bad)).toBe(false);
    }
    expect(HOOK_SOURCE_LOCATION_PATTERN.test(`h${'x'.repeat(1023)}`)).toBe(true);
    expect(HOOK_SOURCE_LOCATION_PATTERN.test(`h${'x'.repeat(1024)}`)).toBe(false);
    expect(APPLICATION_SOURCE_LOCATION_PATTERN.test(`h${'x'.repeat(2047)}`)).toBe(true);
    expect(APPLICATION_SOURCE_LOCATION_PATTERN.test(`h${'x'.repeat(2048)}`)).toBe(false);
  });

  test('a sourceVersion admits git ref characters, a SemVer + and a ^{commit} pin', () => {
    for (const good of ['main', 'v1.2.3+build.5', 'refs/tags/v1^{abcdef0}', 'a'.repeat(40)]) {
      expect(HOOK_SOURCE_VERSION_PATTERN.test(good)).toBe(true);
    }
    for (const bad of ['', 'a b', 'a"b', 'a\\b', 'x'.repeat(129)]) {
      expect(HOOK_SOURCE_VERSION_PATTERN.test(bad)).toBe(false);
    }
  });

  test('a script path is [A-Za-z0-9._/-] up to 256 (hook) or 1,024 (application)', () => {
    expect(HOOK_SCRIPT_PATH_PATTERN.test('hooks/register.sh')).toBe(true);
    expect(HOOK_SCRIPT_PATH_PATTERN.test('hooks/a b.sh')).toBe(false);
    expect(HOOK_SCRIPT_PATH_PATTERN.test('x'.repeat(257))).toBe(false);
    expect(APPLICATION_SCRIPT_PATH_PATTERN.test('x'.repeat(1024))).toBe(true);
    expect(APPLICATION_SCRIPT_PATH_PATTERN.test('x'.repeat(1025))).toBe(false);
  });
});

describe('script outputs guard (R-43)', () => {
  const admitted = [
    '{}',
    '{"endpoint":"https://a.example/x"}',
    '{"a":"1","b":"2"}',
    String.raw`{"a":"say \"hi\" and \\ go"}`,
    '{"a":""}',
    `{"${'k'.repeat(64)}":"v"}`,
    `{"a":"${'x'.repeat(SCRIPT_OUTPUTS_MAX_BYTES - 8)}"}`,
  ];
  const refused = [
    '',
    '{"a": "1"}',
    '{"a":"1", "b":"2"}',
    String.raw`{"a":"\u0041"}`,
    String.raw`{"a":"\/"}`,
    '{"a":"tab\there"}',
    '{"a":"del\u007f"}',
    '{"a":"caf\u00e9"}',
    `{"${'k'.repeat(65)}":"v"}`,
    '{"1a":"v"}',
    '{"a":1}',
    '{"a":"unescaped " quote"}',
    '[]',
  ];

  test.each(admitted)('admits %s', (value) => {
    expect(SCRIPT_OUTPUT_GUARD_PATTERN.test(value)).toBe(true);
  });

  test.each(refused)('refuses %j', (value) => {
    expect(SCRIPT_OUTPUT_GUARD_PATTERN.test(value)).toBe(false);
  });

  test('the pattern cannot see a repeated key, so a hook must refuse it (R-43)', () => {
    expect(SCRIPT_OUTPUT_GUARD_PATTERN.test('{"a":"1","a":"2"}')).toBe(true);
  });

  test('a near miss at the cap is rejected in one linear pass', () => {
    const nearMiss = `{"a":"${'\\"'.repeat(2040)}`;
    const start = Date.now();
    expect(SCRIPT_OUTPUT_GUARD_PATTERN.test(nearMiss)).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('hook environment and roles (R-41, R-42)', () => {
  test('a hook build is handed no onboarding input and no pair credential', () => {
    for (const forbidden of HOOK_FORBIDDEN_ENV_VARS) {
      expect(HOOK_ENV_VARS as readonly string[]).not.toContain(forbidden);
    }
  });

  test('each scope runs in its own project and role', () => {
    expect(HOOK_SCOPES.map((scope) => HOOK_ROLE_KIND_BY_SCOPE[scope])).toEqual(['global-hook', 'app-hook']);
  });
});
