// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Resolver } from 'node:dns/promises';
import {
  checkChallenge,
  LOOKUP_GAP_MS,
  LOOKUP_TIMEOUT_MS,
  LOOKUPS_PER_QUERY,
  nodeDnsLookup,
} from '../../src/shared/dns-challenge';
import { FakeDns } from '../registrar/domains-support';

jest.mock('node:dns/promises', () => ({ Resolver: jest.fn() }));

const DOMAIN = 'portal.example.com';
const NAME = '_tfd-challenge.portal.example.com';
const TOKEN = 'A'.repeat(43);
const RECORD = `tfd-verify=${TOKEN}`;

async function check(dns: FakeDns): Promise<{ outcome: string; sleeps: number[] }> {
  const sleeps: number[] = [];
  const outcome = await checkChallenge(DOMAIN, TOKEN, { lookup: dns, sleep: async (ms) => void sleeps.push(ms) });
  return { outcome, sleeps };
}

describe('§3.4 step 5 sub-step 2: the challenge query', () => {
  test('a TXT record holding the token passes once a CNAME query at the name finds none; the TXT query stops at the match', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[RECORD]]);
    const { outcome, sleeps } = await check(dns);
    expect(outcome).toBe('pass');
    expect(dns.txtNames).toEqual([NAME]);
    expect(dns.cnameNames).toEqual(Array(LOOKUPS_PER_QUERY).fill(NAME));
    expect(sleeps).toEqual(Array(LOOKUPS_PER_QUERY - 1).fill(LOOKUP_GAP_MS));
  });

  test('S-10: a cached negative answer on the first lookups still passes on a later lookup of the same query', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push('ENOTFOUND', 'ENODATA', [[RECORD]]);
    expect((await check(dns)).outcome).toBe('pass');
    expect(dns.txtNames).toHaveLength(3);
  });

  test('a record whose strings were split is joined before the compare', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([['tfd-verify=', TOKEN.slice(0, 20), TOKEN.slice(20)]]);
    expect((await check(dns)).outcome).toBe('pass');
  });

  test('other values at the name are ignored when one record holds the token', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[`tfd-verify=${'B'.repeat(43)}`], [RECORD], ['v=spf1 -all']]);
    expect((await check(dns)).outcome).toBe('pass');
  });

  test('TXT records without the token are a mismatch after five lookups, with no CNAME query', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[`tfd-verify=${'B'.repeat(43)}`]]);
    expect((await check(dns)).outcome).toBe('mismatch');
    expect(dns.txtNames).toHaveLength(LOOKUPS_PER_QUERY);
    expect(dns.cnameNames).toEqual([]);
  });

  test('the token with a different prefix or a substring is not a match', async () => {
    for (const value of [`tfd-verify=${TOKEN}x`, `x${RECORD}`, TOKEN]) {
      const dns = new FakeDns();
      dns.txtAnswers.push([[value]]);
      expect((await check(dns)).outcome).toBe('mismatch');
    }
  });

  test('a CNAME at the name is a mismatch, even when the TXT answer through it holds the token', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[RECORD]]);
    dns.cnameAnswers.push(['challenge.other.example.net']);
    expect((await check(dns)).outcome).toBe('mismatch');
  });

  test('no TXT record and a CNAME at the name is a mismatch', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push('ENODATA');
    dns.cnameAnswers.push('ENODATA', ['dangling.other.example.net']);
    expect((await check(dns)).outcome).toBe('mismatch');
  });

  test('no record at the name is missing (NXDOMAIN or NODATA)', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      const dns = new FakeDns();
      dns.txtAnswers.push(code);
      expect((await check(dns)).outcome).toBe('missing');
      expect(dns.txtNames).toHaveLength(LOOKUPS_PER_QUERY);
    }
  });

  test.each(['ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'ECONNREFUSED'])('%s on every lookup is unresolved, never a pass', async (code) => {
    const dns = new FakeDns();
    dns.txtAnswers.push(code);
    expect((await check(dns)).outcome).toBe('unresolved');
    expect(dns.cnameNames).toEqual([]);
  });

  test('a mix of errors and misses is a miss', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push('ESERVFAIL', 'ENOTFOUND', 'ESERVFAIL');
    dns.cnameAnswers.push('ESERVFAIL');
    expect((await check(dns)).outcome).toBe('missing');
  });

  test('a mix of errors and TXT records without the token is a mismatch', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push('ESERVFAIL', [['other']], 'ESERVFAIL');
    expect((await check(dns)).outcome).toBe('mismatch');
  });

  test('the token found but every CNAME lookup erroring is unresolved: a pass never rests on an error', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[RECORD]]);
    dns.cnameAnswers.push('ESERVFAIL');
    expect((await check(dns)).outcome).toBe('unresolved');
  });

  test('the token found and a CNAME lookup answering among errors passes', async () => {
    const dns = new FakeDns();
    dns.txtAnswers.push([[RECORD]]);
    dns.cnameAnswers.push('ESERVFAIL', 'ENODATA', 'ESERVFAIL');
    expect((await check(dns)).outcome).toBe('pass');
  });
});

describe('§3.4 step 5: each lookup is one try, abandoned after 1 s', () => {
  const ResolverMock = Resolver as unknown as jest.Mock;
  afterEach(() => {
    ResolverMock.mockReset();
    jest.useRealTimers();
  });

  test('a fresh Resolver per lookup, built with timeout 1000 and tries 1', async () => {
    const resolveTxt = jest.fn(async () => [[RECORD]]);
    const resolveCname = jest.fn(async () => ['x.example.net']);
    ResolverMock.mockImplementation(() => ({ resolveTxt, resolveCname, cancel: jest.fn() }));
    const lookup = nodeDnsLookup();
    expect(await lookup.txt(NAME)).toEqual([[RECORD]]);
    expect(await lookup.cname(NAME)).toEqual(['x.example.net']);
    expect(ResolverMock).toHaveBeenCalledTimes(2);
    expect(ResolverMock).toHaveBeenCalledWith({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
    expect(resolveTxt).toHaveBeenCalledWith(NAME);
  });

  test('a lookup still running after 1 s of wall time is cancelled and rejects with ETIMEOUT', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    ResolverMock.mockImplementation(() => ({ resolveTxt: () => new Promise(() => undefined), cancel }));
    const pending = nodeDnsLookup().txt(NAME);
    const settled = pending.catch((error: { code?: string }) => error.code);
    jest.advanceTimersByTime(LOOKUP_TIMEOUT_MS);
    expect(await settled).toBe('ETIMEOUT');
    expect(cancel).toHaveBeenCalled();
  });
});
