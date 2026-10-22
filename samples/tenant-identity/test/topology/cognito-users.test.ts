// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { emailFilter } from '../../src/topology/cognito-users';

describe('emailFilter (ListUsers attribute filter)', () => {
  it('quotes a plain address', () => {
    expect(emailFilter('a@example.com')).toBe('email = "a@example.com"');
  });

  it('escapes a double quote', () => {
    expect(emailFilter('a"b@example.com')).toBe('email = "a\\"b@example.com"');
  });

  it('escapes a backslash before the quote, so the value cannot end early', () => {
    // a\"b -> a\\\"b : the backslash and the quote are both escaped.
    expect(emailFilter('a\\"b@example.com')).toBe('email = "a\\\\\\"b@example.com"');
  });
});
