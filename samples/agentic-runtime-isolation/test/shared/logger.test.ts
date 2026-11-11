// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { errorName, log, logRetries, sdkAttempts } from '../../src/shared/logger';

/** P-9 and standard §4.4: structured fields, and nothing that looks like a secret. */
describe('log', () => {
  let lines: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((line: any) => {
      lines.push(String(line).trimEnd());
      return true;
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

  describe('sdk retried (retried throttles, stress-test plan §7.1)', () => {
    it('sdkAttempts reads $metadata.attempts of a response or an error, undefined otherwise', () => {
      expect(sdkAttempts({ $metadata: { attempts: 3 } })).toBe(3);
      expect(sdkAttempts(Object.assign(new Error('x'), { $metadata: { attempts: 2 } }))).toBe(2);
      expect(sdkAttempts({ $metadata: {} })).toBeUndefined();
      expect(sdkAttempts({})).toBeUndefined();
      expect(sdkAttempts(undefined)).toBeUndefined();
      expect(sdkAttempts('ThrottlingException')).toBeUndefined();
    });

    it('writes nothing for a first-attempt success or an unknown count', () => {
      logRetries('sts', 'AssumeRole', { $metadata: { attempts: 1 } });
      logRetries('sts', 'AssumeRole', { $metadata: {} });
      logRetries('sts', 'AssumeRole', undefined);
      expect(lines).toEqual([]);
    });

    it('writes one WARN line with service, operation and attempts for a retried success', () => {
      logRetries('kms', 'Sign', { $metadata: { attempts: 2 }, Signature: new Uint8Array(1) });
      expect(JSON.parse(lines[0])).toEqual({ level: 'WARN', message: 'sdk retried', service: 'kms', operation: 'Sign', attempts: 2 });
    });

    it('adds the error name only, never its message, when every attempt failed', () => {
      const error = Object.assign(new Error('Rate exceeded for arn:aws:sts::111122223333:assumed-role/x'), {
        name: 'ThrottlingException',
        $metadata: { attempts: 3 },
      });
      logRetries('sts', 'AssumeRole', error, error);
      expect(JSON.parse(lines[0])).toEqual({
        level: 'WARN',
        message: 'sdk retried',
        service: 'sts',
        operation: 'AssumeRole',
        attempts: 3,
        error: 'ThrottlingException',
      });
      expect(lines[0]).not.toContain('Rate exceeded');
      expect(lines[0]).not.toContain('111122223333');
    });
  });
});
