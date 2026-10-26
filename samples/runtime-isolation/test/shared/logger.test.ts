// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { errorName, log } from '../../src/shared/logger';

/** P-9 and standard §4.4: structured fields, and nothing that looks like a secret. */
describe('log', () => {
  let lines: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });
  afterEach(() => spy.mockRestore());

  it('writes one JSON object per line with level, message and fields', () => {
    log.info('request served', { tenantId: 'tenant-a', sessionPrefix: 'abc', status: 200 });
    expect(JSON.parse(lines[0])).toEqual({ level: 'INFO', message: 'request served', tenantId: 'tenant-a', sessionPrefix: 'abc', status: 200 });
  });

  it.each(['token', 'userToken', 'Authorization', 'secretAccessKey', 'credentials', 'headerValue', 'cookie', 'password'])(
    'drops a field named %s',
    (name) => {
      log.warn('x', { [name]: 'SHOULD-NOT-APPEAR', tenantId: 't' });
      const written = JSON.parse(lines[0]);
      expect(written).not.toHaveProperty(name);
      expect(lines[0]).not.toContain('SHOULD-NOT-APPEAR');
      expect(written.tenantId).toBe('t');
    },
  );

  it('drops undefined fields', () => {
    log.error('x', { ttfbMs: undefined, status: 500 });
    expect(JSON.parse(lines[0])).toEqual({ level: 'ERROR', message: 'x', status: 500 });
  });

  it('errorName is the class name only, never the message', () => {
    expect(errorName(new TypeError('contains a secret'))).toBe('TypeError');
    expect(errorName('string')).toBe('string');
  });
});
