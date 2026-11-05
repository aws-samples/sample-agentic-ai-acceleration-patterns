// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { headerValue, missingScopes } from '../../src/shared/headers';

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
