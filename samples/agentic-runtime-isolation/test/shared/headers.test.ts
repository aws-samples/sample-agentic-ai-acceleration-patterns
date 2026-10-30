// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { hasAnyScope, headerValue, missingScopes } from '../../src/shared/headers';

describe('headerValue', () => {
  it('matches the header name case-insensitively', () => {
    expect(headerValue({ Authorization: 'Bearer a' }, 'authorization')).toBe('Bearer a');
    expect(headerValue({ authorization: 'Bearer b' }, 'Authorization')).toBe('Bearer b');
    expect(headerValue({ AUTHORIZATION: 'Bearer c' }, 'authorization')).toBe('Bearer c');
  });

  it('is undefined for a missing header, an undefined value, or no headers at all', () => {
    expect(headerValue({ 'x-other': 'v' }, 'authorization')).toBeUndefined();
    expect(headerValue({ authorization: undefined }, 'authorization')).toBeUndefined();
    expect(headerValue(undefined, 'authorization')).toBeUndefined();
    expect(headerValue(null, 'authorization')).toBeUndefined();
    expect(headerValue({}, 'authorization')).toBeUndefined();
  });
});

describe('missingScopes', () => {
  it('is empty when every required scope is granted (AND, order-free)', () => {
    expect(missingScopes(['b', 'a', 'c'], ['a', 'b'])).toEqual([]);
    expect(missingScopes(['a'], [])).toEqual([]);
    expect(missingScopes([], [])).toEqual([]);
  });

  it('names each required scope the grant lacks, in required order', () => {
    expect(missingScopes(['a'], ['b', 'a', 'c'])).toEqual(['b', 'c']);
    expect(missingScopes([], ['a'])).toEqual(['a']);
  });
});

describe('hasAnyScope (ADR-0025)', () => {
  it('is true when the grant carries at least one of the backend scopes (OR, order-free)', () => {
    expect(hasAnyScope(['default/chat'], ['billing/read', 'default/chat'])).toBe(true);
    expect(hasAnyScope(['billing/invoke', 'x/y'], ['billing/read', 'billing/invoke'])).toBe(true);
    expect(hasAnyScope(['billing/read', 'billing/invoke'], ['billing/read'])).toBe(true);
  });

  it('is false when none is carried, and false for an empty backend list (fail closed)', () => {
    expect(hasAnyScope(['default/chat'], ['billing/read', 'billing/invoke'])).toBe(false);
    expect(hasAnyScope([], ['billing/read'])).toBe(false);
    expect(hasAnyScope(['default/chat'], [])).toBe(false);
    expect(hasAnyScope([], [])).toBe(false);
  });

  it('matches whole names only: a prefix or a different case is not a match', () => {
    expect(hasAnyScope(['billing'], ['billing/read'])).toBe(false);
    expect(hasAnyScope(['billing/rea'], ['billing/read'])).toBe(false);
    expect(hasAnyScope(['Billing/read'], ['billing/read'])).toBe(false);
  });
});
