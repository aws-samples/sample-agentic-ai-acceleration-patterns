// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The synth-time `allowedOrigins` check (spec §5.4.1, ADR-0040): which
 * entries synthesise and which fail, naming the entry.
 */

import {
  MAX_ALLOWED_ORIGINS,
  readAllowedOrigins,
  validateAllowedOrigins,
} from '../../src/shared/allowed-origins';

describe('readAllowedOrigins: missing or empty means no list', () => {
  it.each([[undefined], [null], [''], [[]]])('%p -> []', (value) => {
    expect(readAllowedOrigins(value)).toEqual([]);
  });

  it('splits a context string on , without trimming', () => {
    expect(readAllowedOrigins('https://a.example.com,https://*.t.example.com')).toEqual([
      'https://a.example.com',
      'https://*.t.example.com',
    ]);
    expect(readAllowedOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      ' https://b.example.com',
    ]);
  });

  it('takes a list of strings as is, and refuses anything else', () => {
    expect(readAllowedOrigins(['https://a.example.com'])).toEqual(['https://a.example.com']);
    expect(() => readAllowedOrigins(42)).toThrow(/comma-separated/);
    expect(() => readAllowedOrigins([1])).toThrow(/comma-separated/);
  });
});

describe('validateAllowedOrigins', () => {
  it.each([
    'https://app.example.com',
    'https://app.example.com:8443',
    'https://xn--bcher-kva.example.com',
    'https://*.tenants.example.com',
    'https://*.app.example.co.uk',
  ])('accepts %s', (entry) => {
    expect(() => validateAllowedOrigins([entry])).not.toThrow();
  });

  it('accepts no list', () => {
    expect(() => validateAllowedOrigins([])).not.toThrow();
  });

  it.each([
    ['http://app.example.com', 'scheme'],
    ['https://app.example.com/', 'trailing slash'],
    ['https://app.example.com/path', 'path'],
    ['https://app.example.com?q=1', 'query'],
    ['https://app.example.com#f', 'fragment'],
    ['https://App.example.com', 'upper case'],
    ['https://app.example.com.', 'trailing dot'],
    ['https://localhost', 'single label'],
    ['http://localhost:5173', 'local dev server'],
    ['https://10.0.0.1', 'IPv4 literal'],
    ['https://[::1]', 'IPv6 literal'],
    ['https://app.example.com:443', 'default port'],
    ['https://app.example.com:0443', 'leading zero'],
    ['https://app.example.com:65536', 'port too high'],
    ['https://*.tenants.example.com:8443', 'port on a pattern'],
    ['https://a.*.example.com', '* not the first label'],
    ['https://*a.example.com', '* inside a label'],
    ['https://*.*.example.com', 'two wildcards'],
    ['*', 'bare *'],
    ['null', 'null'],
    ['', 'empty entry'],
    [' https://app.example.com', 'leading space'],
    ['https://-app.example.com', 'edge hyphen'],
    ['https://*.com', 'pattern under a TLD'],
    ['https://*.co.uk', 'pattern under an ICANN suffix'],
    ['https://*.cloudfront.net', 'pattern under a private suffix'],
    ['https://*.s3.amazonaws.com', 'pattern under a private suffix'],
    ['https://*.us-east-1.elb.amazonaws.com', 'pattern under a wildcard rule'],
  ])('refuses %s (%s), naming the entry', (entry) => {
    expect(() => validateAllowedOrigins([entry])).toThrow(`'${entry}'`);
  });

  it('refuses a host longer than 253 characters', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`;
    expect(() => validateAllowedOrigins([`https://${host}`])).toThrow(/253/);
  });

  it('refuses a repeated entry', () => {
    expect(() => validateAllowedOrigins(['https://a.example.com', 'https://a.example.com'])).toThrow(/repeated/);
  });

  it('refuses an empty entry inside the list (a,,b)', () => {
    expect(() => validateAllowedOrigins(readAllowedOrigins('https://a.example.com,,https://b.example.com'))).toThrow(
      "''",
    );
  });

  it(`refuses more than ${MAX_ALLOWED_ORIGINS} entries`, () => {
    const list = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://a${i}.example.com`);
    expect(() => validateAllowedOrigins(list.slice(0, MAX_ALLOWED_ORIGINS))).not.toThrow();
    expect(() => validateAllowedOrigins(list)).toThrow(/at most 20/);
  });

  it('refuses more than 1,024 characters in total', () => {
    const list = Array.from({ length: 10 }, (_, i) => `https://${'x'.repeat(90)}${i}.example.com`);
    expect(list.join(',').length).toBeGreaterThan(1024);
    expect(() => validateAllowedOrigins(list)).toThrow(/1024/);
  });
});
