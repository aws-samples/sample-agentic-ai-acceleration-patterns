// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import {
  base32,
  CONVERSATION_ID_PATTERN,
  isValidConversationId,
  PREFIX_PATTERN,
  prefixOf,
  RANDOM_UNIT_ID_PATTERN,
  randomUnitId,
  sessionPrefix,
  sessionUnitId,
} from '../../src/shared/session';

/** The unit module is the contract between both ingresses and the tests (ADR-0002, ADR-0013). */
describe('base32', () => {
  it('matches RFC 4648 for a known vector (lower case, no padding)', () => {
    // "foobar" -> MZXW6YTBOI
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    expect(base32(Buffer.from('f'))).toBe('my');
    expect(base32(Buffer.alloc(0))).toBe('');
  });

  it('turns 32 bytes into 52 characters of [a-z2-7]', () => {
    const out = base32(Buffer.alloc(32, 0xff));
    expect(out).toHaveLength(52);
    expect(out).toMatch(/^[a-z2-7]+$/);
  });
});

describe('sessionPrefix (ADR-0002, spec §4)', () => {
  it("scope 'user' hashes tenant_id|sub and takes 26 base32 chars", () => {
    const expected = base32(createHash('sha256').update('tenant-a|user-1').digest()).slice(0, 26);
    expect(sessionPrefix('tenant-a', 'user-1', 'user')).toBe(expected);
    expect(sessionPrefix('tenant-a', 'user-1', 'user')).toMatch(PREFIX_PATTERN);
  });

  it("scope 'tenant' hashes tenant_id only, so two users share a prefix", () => {
    expect(sessionPrefix('tenant-a', 'user-1', 'tenant')).toBe(sessionPrefix('tenant-a', 'user-2', 'tenant'));
    expect(sessionPrefix('tenant-a', 'user-1', 'user')).not.toBe(sessionPrefix('tenant-a', 'user-2', 'user'));
  });

  it('two tenants never share a prefix, even with the same sub', () => {
    expect(sessionPrefix('tenant-a', 'user-1', 'user')).not.toBe(sessionPrefix('tenant-b', 'user-1', 'user'));
    expect(sessionPrefix('tenant-a', 'u', 'tenant')).not.toBe(sessionPrefix('tenant-b', 'u', 'tenant'));
  });

  it('the separator keeps tenant and sub apart ("ab|c" is not "a|bc")', () => {
    expect(sessionPrefix('ab', 'c', 'user')).not.toBe(sessionPrefix('a', 'bc', 'user'));
  });

  it('refuses empty inputs', () => {
    expect(() => sessionPrefix('', 'u', 'user')).toThrow(/non-empty/);
    expect(() => sessionPrefix('t', '', 'user')).toThrow(/non-empty/);
  });

  it('is the value the spike observed for its tenant/user pair shape', () => {
    // Stable: the same inputs always give the same prefix (recomputable at ingress, ADR-0002).
    const a = sessionPrefix('tenanta', 'sub-a1', 'user');
    expect(sessionPrefix('tenanta', 'sub-a1', 'user')).toBe(a);
  });
});

describe('conversationId (spec §4)', () => {
  it.each(['conversationA1x0001', 'a'.repeat(16), 'Z9'.repeat(32)])('accepts %s', (id) => {
    expect(isValidConversationId(id)).toBe(true);
    expect(CONVERSATION_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(['short', 'a'.repeat(15), 'a'.repeat(65), 'has-dash-0000000000', 'has space 00000000', '', 42, null, undefined])(
    'refuses %p',
    (id) => {
      expect(isValidConversationId(id)).toBe(false);
    },
  );
});

describe('sessionUnitId', () => {
  it('is s-<prefix>-<conversationId>, 45 to 93 characters', () => {
    const id = sessionUnitId('tenant-a', 'user-1', 'user', 'conversationA1x0001');
    expect(id).toBe(`s-${sessionPrefix('tenant-a', 'user-1', 'user')}-conversationA1x0001`);
    expect(id.length).toBeGreaterThanOrEqual(45);
    expect(sessionUnitId('t', 'u', 'user', 'x'.repeat(64))).toHaveLength(93);
    expect(sessionUnitId('t', 'u', 'user', 'x'.repeat(16))).toHaveLength(45);
  });

  it('refuses an unvalidated conversationId rather than build an id from it', () => {
    expect(() => sessionUnitId('t', 'u', 'user', 'bad id')).toThrow(/conversationId/);
  });

  it('prefixOf recovers the prefix for logging', () => {
    const id = sessionUnitId('tenant-a', 'user-1', 'user', 'conversationA1x0001');
    expect(prefixOf(id)).toBe(sessionPrefix('tenant-a', 'user-1', 'user'));
  });
});

describe('randomUnitId (ADR-0013)', () => {
  it('is s- plus 52 base32 characters of 32 random bytes', () => {
    const id = randomUnitId();
    expect(id).toMatch(RANDOM_UNIT_ID_PATTERN);
    expect(id).toHaveLength(54);
  });

  it('uses the random source it is given, so no two requests share a unit', () => {
    let n = 0;
    const random = (size: number) => Buffer.alloc(size, ++n);
    expect(randomUnitId(random)).not.toBe(randomUnitId(random));
    expect(new Set(Array.from({ length: 50 }, () => randomUnitId())).size).toBe(50);
  });
});
