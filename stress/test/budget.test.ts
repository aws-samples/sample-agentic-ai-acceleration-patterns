// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { overdraws, parseDraws, QUOTAS, sumDraws } from '../src/budget';

describe('quota budget (spec §4.4, P-4)', () => {
  it('parses a slice budget', () => {
    const draws = parseDraws('s', JSON.stringify({ draws: [{ account: 'cell-1', quota: 'lambda-concurrency', amount: 400 }] }));
    expect(draws).toEqual([{ account: 'cell-1', quota: 'lambda-concurrency', amount: 400 }]);
  });

  it.each([
    ['not JSON', 'nope', /no JSON/],
    ['no draws', '{}', /"draws" array/],
    ['bad account', JSON.stringify({ draws: [{ account: 'cell-0', quota: 'lambda-concurrency', amount: 1 }] }), /platform/],
    ['unknown quota', JSON.stringify({ draws: [{ account: 'platform', quota: 'sqs', amount: 1 }] }), /not a known quota/],
    ['negative amount', JSON.stringify({ draws: [{ account: 'platform', quota: 'kms-rsa-rps', amount: -1 }] }), /non-negative/],
  ])('refuses %s', (_name, text, pattern) => {
    expect(() => parseDraws('s', text)).toThrow(pattern);
  });

  it('adds draws per account and quota', () => {
    const sums = sumDraws([
      { account: 'platform', quota: 'codebuild-linux-small', amount: 50 },
      { account: 'platform', quota: 'codebuild-linux-small', amount: 50 },
      { account: 'cell-1', quota: 'codebuild-linux-small', amount: 5 },
    ]);
    expect(sums.get('platform')?.get('codebuild-linux-small')).toBe(100);
    expect(sums.get('cell-1')?.get('codebuild-linux-small')).toBe(5);
  });

  it('refuses a sum over the limit, using the default when the account has no value', () => {
    const sums = sumDraws([
      { account: 'platform', quota: 'codebuild-linux-small', amount: 100 },
      { account: 'cell-1', quota: 'lambda-concurrency', amount: 900 },
    ]);
    expect(overdraws(sums)).toEqual([{ account: 'platform', quota: 'codebuild-linux-small', sum: 100, limit: 1 }]);
    expect(overdraws(sums, { 'platform': { 'codebuild-linux-small': 300 }, 'cell-1': { 'lambda-concurrency': 800 } })).toEqual([
      { account: 'cell-1', quota: 'lambda-concurrency', sum: 900, limit: 800 },
    ]);
  });

  it('gives every quota a positive default and a code where Service Quotas has one', () => {
    for (const q of Object.values(QUOTAS)) {
      expect(q.defaultLimit).toBeGreaterThan(0);
      if ('quotaCode' in q) expect(q.quotaCode).toMatch(/^L-[0-9A-F]{8}$/);
    }
  });
});
