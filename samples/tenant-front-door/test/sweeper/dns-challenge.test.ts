// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  challengeRecordName,
  checkChallenge,
  type ChallengeCheckDeps,
  type LookupAnswer,
  nodeLookup,
  type ResolverLike,
} from '../../src/shared/dns-challenge';

const DOMAIN = 'shop.example.com';
const NAME = '_tfd-challenge.shop.example.com';
const TOKEN = 'T'.repeat(43);
const VALUE = `tfd-verify=${TOKEN}`;

const txt = (...records: string[][]): LookupAnswer => ({ kind: 'txt', records });
const cname = (...records: string[]): LookupAnswer => ({ kind: 'cname', records });
const NONE: LookupAnswer = { kind: 'none' };
const ERROR: LookupAnswer = { kind: 'error' };

/** A lookup that answers each type from its own script, then repeats the script's last answer. */
function scripted(txtAnswers: LookupAnswer[], cnameAnswers: LookupAnswer[] = [NONE]): ChallengeCheckDeps & { calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const index = { TXT: 0, CNAME: 0 };
  return {
    calls,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); },
    lookup: async (type, name) => {
      expect(name).toBe(NAME);
      calls.push(type);
      const script = type === 'TXT' ? txtAnswers : cnameAnswers;
      const answer = script[Math.min(index[type], script.length - 1)];
      index[type]++;
      return answer;
    },
  };
}

describe('domain challenge lookup (spec §3.4 step 5 sub-step 2, ADR-0018)', () => {
  it('names the challenge record', () => {
    expect(challengeRecordName(DOMAIN)).toBe(NAME);
  });

  it('passes on a record holding the token, after a CNAME query that finds none', async () => {
    const deps = scripted([txt(['other=1'], [VALUE])]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('pass');
    expect(deps.calls).toEqual(['TXT', 'CNAME', 'CNAME', 'CNAME', 'CNAME', 'CNAME']);
  });

  it('joins a record whose strings were split', async () => {
    const deps = scripted([txt([VALUE.slice(0, 20), VALUE.slice(20)])]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('pass');
  });

  it('passes on a later lookup after earlier misses, and stops at the match', async () => {
    const deps = scripted([NONE, NONE, txt([VALUE])]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('pass');
    expect(deps.calls.filter((c) => c === 'TXT')).toHaveLength(3);
  });

  it('makes five lookups about 100 ms apart when none matches', async () => {
    const deps = scripted([NONE], [NONE]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('missing');
    expect(deps.calls).toEqual(['TXT', 'TXT', 'TXT', 'TXT', 'TXT', 'CNAME', 'CNAME', 'CNAME', 'CNAME', 'CNAME']);
    expect(deps.sleeps).toEqual(Array(8).fill(100));
  });

  it('is a mismatch when any lookup held other TXT records, and queries no CNAME', async () => {
    const deps = scripted([NONE, txt(['tfd-verify=someone-else']), NONE, ERROR, NONE]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('mismatch');
    expect(deps.calls).not.toContain('CNAME');
  });

  it('ignores a former holder\'s token', async () => {
    const deps = scripted([txt([`tfd-verify=${'F'.repeat(43)}`])]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('mismatch');
  });

  it('is unresolved only when every TXT lookup errors', async () => {
    const deps = scripted([ERROR]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('unresolved');
    expect(deps.calls).toEqual(['TXT', 'TXT', 'TXT', 'TXT', 'TXT']);
  });

  it('is missing for a mix of errors and misses', async () => {
    const deps = scripted([ERROR, NONE, ERROR, ERROR, ERROR], [ERROR]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('missing');
  });

  it('is a mismatch when the name holds a CNAME and no TXT record', async () => {
    const deps = scripted([NONE], [NONE, cname('records.other.example.net')]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('mismatch');
    expect(deps.calls.filter((c) => c === 'CNAME')).toHaveLength(2);
  });

  it('is a mismatch when the token comes through a CNAME', async () => {
    const deps = scripted([txt([VALUE])], [cname('records.other.example.net')]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('mismatch');
    expect(deps.calls).toEqual(['TXT', 'CNAME']);
  });

  it('is unresolved when the token matches but every CNAME lookup errors', async () => {
    const deps = scripted([txt([VALUE])], [ERROR]);
    expect(await checkChallenge(DOMAIN, TOKEN, deps)).toBe('unresolved');
  });
});

describe('node lookup (one try, 1 s of wall time)', () => {
  function resolver(behaviour: Partial<ResolverLike>): ResolverLike & { cancelled: number } {
    const r = {
      cancelled: 0,
      resolveTxt: behaviour.resolveTxt ?? (async () => []),
      resolveCname: behaviour.resolveCname ?? (async () => []),
      cancel() { r.cancelled++; },
    };
    return r;
  }

  const coded = (code: string): Error => Object.assign(new Error(code), { code });

  it('returns TXT records and CNAME targets', async () => {
    const r = resolver({ resolveTxt: async () => [[VALUE]], resolveCname: async () => ['x.example.net'] });
    expect(await nodeLookup(() => r)('TXT', NAME)).toEqual({ kind: 'txt', records: [[VALUE]] });
    expect(await nodeLookup(() => r)('CNAME', NAME)).toEqual({ kind: 'cname', records: ['x.example.net'] });
  });

  it.each(['ENOTFOUND', 'ENODATA'])('reads %s as no record', async (code) => {
    const r = resolver({ resolveTxt: async () => { throw coded(code); } });
    expect(await nodeLookup(() => r)('TXT', NAME)).toEqual({ kind: 'none' });
  });

  it.each(['ESERVFAIL', 'EREFUSED', 'ETIMEOUT', 'ECONNREFUSED'])('reads %s as an error', async (code) => {
    const r = resolver({ resolveTxt: async () => { throw coded(code); } });
    expect(await nodeLookup(() => r)('TXT', NAME)).toEqual({ kind: 'error' });
  });

  it('abandons a lookup after its limit and cancels it', async () => {
    const r = resolver({ resolveTxt: () => new Promise(() => undefined) });
    const started = Date.now();
    expect(await nodeLookup(() => r, 50)('TXT', NAME)).toEqual({ kind: 'error' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.cancelled).toBe(1);
  });

  it('uses a fresh resolver for each lookup', async () => {
    let made = 0;
    const lookup = nodeLookup(() => { made++; return resolver({}); });
    await lookup('TXT', NAME);
    await lookup('CNAME', NAME);
    expect(made).toBe(2);
  });
});
