// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { readJsonContext } from '../../src/shared/context';
import { validateConcurrentBuildLimit } from '../../src/tenant/validation';

/** How a context value reaches the stack: a CLI string or a cdk.json value (src/main.ts). */
describe('readJsonContext', () => {
  const read = (value: unknown) =>
    readJsonContext<unknown>(new App({ context: { key: value } }).node, 'key');

  test('a CLI number string and a cdk.json number both arrive as a number', () => {
    expect(read('50')).toBe(50);
    expect(read(50)).toBe(50);
    expect(validateConcurrentBuildLimit(read('50'))).toBe(50);
  });

  test('a quoted string stays a string, so the build-limit check refuses it', () => {
    expect(read('"50"')).toBe('50');
    expect(() => validateConcurrentBuildLimit(read('"50"'))).toThrow(/Invalid concurrentBuildLimit "50"/);
  });

  test('absent or empty is undefined; a list string is parsed; bad JSON names the key', () => {
    expect(readJsonContext(new App().node, 'key')).toBeUndefined();
    expect(read('')).toBeUndefined();
    expect(read('["arn:aws:iam::123456789012:policy/P"]')).toEqual(['arn:aws:iam::123456789012:policy/P']);
    expect(() => read('abc')).toThrow(/The key context value is not valid JSON/);
  });
});
