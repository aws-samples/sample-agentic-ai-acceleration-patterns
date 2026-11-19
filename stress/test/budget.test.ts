// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { isAccountLabel, overdraws, parseDraws, parseLimits, QUOTAS, sumDraws } from '../src/budget';

describe('quota budget (spec §4.4, P-4)', () => {
  it('parses a slice budget', () => {
    const draws = parseDraws('s', JSON.stringify({ draws: [{ account: 'cell-account-1', quota: 'lambda-concurrency', amount: 400 }] }), 1);
    expect(draws).toEqual([{ account: 'cell-account-1', quota: 'lambda-concurrency', amount: 400 }]);
  });

  it.each([
    ['not JSON', 'nope', /no JSON/],
    ['no draws', '{}', /"draws" array/],
    ['null', 'null', /"draws" array/],
    ['a cell, not a cell account', JSON.stringify({ draws: [{ account: 'cell-1', quota: 'lambda-concurrency', amount: 1 }] }), /cell-account-1/],
    ['a cell account beyond the tier', JSON.stringify({ draws: [{ account: 'cell-account-3', quota: 'lambda-concurrency', amount: 1 }] }), /"cell-account-1".."cell-account-2"/],
    ['unknown quota', JSON.stringify({ draws: [{ account: 'platform', quota: 'sqs', amount: 1 }] }), /not a known quota/],
    ['negative amount', JSON.stringify({ draws: [{ account: 'platform', quota: 'kms-rsa-rps', amount: -1 }] }), /non-negative/],
  ])('refuses %s', (_name, text, pattern) => {
    expect(() => parseDraws('s', text, 2)).toThrow(pattern);
  });

  it('accepts platform and the tier cell accounts only', () => {
    expect(isAccountLabel('platform', 1)).toBe(true);
    expect(isAccountLabel('cell-account-2', 2)).toBe(true);
    expect(isAccountLabel('cell-account-2', 1)).toBe(false);
    expect(isAccountLabel('cell-account-0', 2)).toBe(false);
  });

  it('adds draws per account and quota', () => {
    const sums = sumDraws([
      { account: 'platform', quota: 'codebuild-linux-small', amount: 50 },
      { account: 'platform', quota: 'codebuild-linux-small', amount: 50 },
      { account: 'cell-account-1', quota: 'codebuild-linux-small', amount: 5 },
    ]);
    expect(sums.get('platform')?.get('codebuild-linux-small')).toBe(100);
    expect(sums.get('cell-account-1')?.get('codebuild-linux-small')).toBe(5);
  });

  it('refuses a sum over the limit, using the default when the limits file has no value', () => {
    const sums = sumDraws([
      { account: 'platform', quota: 'codebuild-linux-small', amount: 100 },
      { account: 'cell-account-1', quota: 'lambda-concurrency', amount: 900 },
    ]);
    expect(overdraws(sums)).toEqual([{ account: 'platform', quota: 'codebuild-linux-small', sum: 100, limit: 1 }]);
    expect(overdraws(sums, { 'platform': { 'codebuild-linux-small': 300 }, 'cell-account-1': { 'lambda-concurrency': 800 } })).toEqual([
      { account: 'cell-account-1', quota: 'lambda-concurrency', sum: 900, limit: 800 },
    ]);
  });

  it('parses a limits file and names a misspelling', () => {
    expect(parseLimits(JSON.stringify({ platform: { 'codebuild-linux-small': 300 } }), 'l.json', 1)).toEqual({ platform: { 'codebuild-linux-small': 300 } });
    expect(() => parseLimits(JSON.stringify({ platform: { 'lamda-concurrency': 1 } }), 'l.json', 1)).toThrow(/platform.lamda-concurrency is not a known quota/);
    expect(() => parseLimits(JSON.stringify({ 'cell-account-2': {} }), 'l.json', 1)).toThrow(/account cell-account-2/);
    expect(() => parseLimits(JSON.stringify({ platform: { 'kms-rsa-rps': 'many' } }), 'l.json', 1)).toThrow(/non-negative number/);
    expect(() => parseLimits('[]', 'l.json', 1)).toThrow(/object of accounts/);
  });

  it('gives every quota a positive default and a code where Service Quotas has one', () => {
    for (const q of Object.values(QUOTAS)) {
      expect(q.defaultLimit).toBeGreaterThan(0);
      if ('quotaCode' in q) expect(q.quotaCode).toMatch(/^L-[0-9A-F]{8}$/);
    }
  });
});
