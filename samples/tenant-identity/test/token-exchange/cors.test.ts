// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The runtime origin match and header helpers (spec §5.4.1, ADR-0040).
 */

import {
  addHeaders,
  corsHeaders,
  normaliseContentType,
  originMatches,
  parseAllowedOriginsEnv,
  requestOrigin,
} from '../../src/token-exchange/cors';

const LIST = ['https://app.example.com', 'https://dev.example.com:8443', 'https://*.tenants.example.com'];

describe('originMatches', () => {
  it.each([
    'https://app.example.com',
    'https://dev.example.com:8443',
    'https://acme.tenants.example.com',
    'https://a-1.tenants.example.com',
    'https://01hzx8k9p0qrst7vwxyz1a2b3c.tenants.example.com',
  ])('matches %s', (origin) => {
    expect(originMatches(LIST, origin)).toBe(true);
  });

  it.each([
    ['https://App.example.com', 'upper case'],
    ['http://app.example.com', 'http'],
    ['https://app.example.com:443', 'explicit default port'],
    ['https://app.example.com/', 'trailing slash'],
    ['https://app.example.com.evil.test', 'suffix look-alike'],
    ['https://xapp.example.com', 'prefix look-alike'],
    ['https://dev.example.com', 'listed only with a port'],
    ['https://tenants.example.com', 'the bare pattern domain'],
    ['https://a.b.tenants.example.com', 'two labels'],
    ['https://-a.tenants.example.com', 'edge hyphen'],
    ['https://Acme.tenants.example.com', 'upper-case label'],
    ['https://acme.tenants.example.com:8443', 'port on a pattern match'],
    ['https://eviltenants.example.com', 'no dot before the domain'],
    ['null', 'null'],
    ['', 'empty'],
  ])('does not match %s (%s)', (origin) => {
    expect(originMatches(LIST, origin)).toBe(false);
  });
});

describe('requestOrigin', () => {
  it('reads one Origin, header name in either case', () => {
    expect(requestOrigin({ Origin: ['https://app.example.com'] })).toBe('https://app.example.com');
    expect(requestOrigin({ origin: ['https://app.example.com'] })).toBe('https://app.example.com');
  });

  it.each([
    ['no headers', null],
    ['no Origin', { 'content-type': ['x'] }],
    ['two values', { origin: ['https://app.example.com', 'https://evil.example.com'] }],
    ['two header names', { Origin: ['https://app.example.com'], origin: ['https://evil.example.com'] }],
  ])('is undefined for %s', (_label, headers) => {
    expect(requestOrigin(headers as Record<string, string[]> | null)).toBeUndefined();
  });
});

describe('corsHeaders', () => {
  it('sends nothing when the list is empty', () => {
    expect(corsHeaders([], 'https://app.example.com')).toEqual({});
  });

  it('echoes a listed origin with Vary: Origin', () => {
    expect(corsHeaders(LIST, 'https://acme.tenants.example.com')).toEqual({
      'Vary': 'Origin',
      'Access-Control-Allow-Origin': 'https://acme.tenants.example.com',
    });
  });

  it.each([['https://evil.example.com'], ['null'], [undefined]])('sends only Vary for %p', (origin) => {
    expect(corsHeaders(LIST, origin)).toEqual({ Vary: 'Origin' });
  });

  it('never sends credentials, methods or headers', () => {
    const keys = Object.keys(corsHeaders(LIST, 'https://app.example.com')).map((k) => k.toLowerCase());
    expect(keys).not.toContain('access-control-allow-credentials');
    expect(keys).not.toContain('access-control-allow-methods');
    expect(keys).not.toContain('access-control-allow-headers');
  });
});

describe('parseAllowedOriginsEnv', () => {
  it.each([[undefined], ['']])('%p is no list', (value) => {
    expect(parseAllowedOriginsEnv(value)).toEqual([]);
  });

  it('splits on ,', () => {
    expect(parseAllowedOriginsEnv(LIST.join(','))).toEqual(LIST);
  });
});

describe('addHeaders', () => {
  it('replaces a header of the same name in any case', () => {
    const response = { headers: { 'vary': 'Accept', 'Cache-Control': 'no-store' } };
    addHeaders(response, { Vary: 'Origin' });
    expect(response.headers).toEqual({ 'Cache-Control': 'no-store', 'Vary': 'Origin' });
  });
});

describe('normaliseContentType', () => {
  it.each([
    'application/x-www-form-urlencoded;charset=UTF-8',
    'application/x-www-form-urlencoded; charset=utf-8',
    'Application/X-WWW-Form-Urlencoded',
  ])('drops parameters from %s', (value) => {
    const request = { headers: { 'Content-Type': value } };
    normaliseContentType(request);
    expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('leaves another media type alone', () => {
    const request = { headers: { 'content-type': 'application/json; charset=utf-8' } };
    normaliseContentType(request);
    expect(request.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});
