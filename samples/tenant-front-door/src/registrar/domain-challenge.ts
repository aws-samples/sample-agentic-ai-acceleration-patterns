// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Resolver } from 'node:dns/promises';
import { CHALLENGE_RECORD_PREFIX, CHALLENGE_VALUE_PREFIX } from '../shared/contracts';

/**
 * The domain challenge lookup (spec §3.4 step 5 sub-steps 2 and 5,
 * ADR-0018, spike S-10): resolves `_tfd-challenge.<d>` with the function's
 * default resolver and compares it with the tenant's token. A resolver
 * error is never a pass, and a CNAME at the name is a mismatch whatever
 * its target holds.
 */

/** `missing`, `mismatch` and `unresolved` are the model's `ChallengeResult` values. */
export type ChallengeOutcome = 'pass' | 'missing' | 'mismatch' | 'unresolved';

/** One lookup each; a rejection carries the resolver's error `code`. */
export interface DnsLookup {
  txt(name: string): Promise<string[][]>;
  cname(name: string): Promise<string[]>;
}

/** Lookups per query, and the pause between them (§3.4 step 5). */
export const LOOKUPS_PER_QUERY = 5;
export const LOOKUP_GAP_MS = 100;
/** Each lookup is one try, abandoned after this much wall time: a chosen value; S-10's longest lookup took 64 ms. */
export const LOOKUP_TIMEOUT_MS = 1_000;

/** The name does not exist, or holds no record of the type: an answer, not an error. */
const NO_RECORD_CODES: readonly string[] = ['ENOTFOUND', 'ENODATA'];

export function challengeRecordName(domain: string): string {
  return `${CHALLENGE_RECORD_PREFIX}${domain}`;
}

export function challengeRecordValue(token: string): string {
  return `${CHALLENGE_VALUE_PREFIX}${token}`;
}

/**
 * Lookups through a fresh Node.js `Resolver` with `timeout: 1000, tries: 1`
 * each, so the `/etc/resolv.conf` defaults (`timeout:2 attempts:5`) do not
 * apply, and a wall-time guard that cancels it after the same 1 s.
 */
export function nodeDnsLookup(): DnsLookup {
  const once = async <T>(run: (resolver: Resolver) => Promise<T>): Promise<T> => {
    const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        reject(Object.assign(new Error('lookup abandoned'), { code: 'ETIMEOUT' }));
      }, LOOKUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([run(resolver), guard]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    txt: (name) => once((r) => r.resolveTxt(name)),
    cname: (name) => once((r) => r.resolveCname(name)),
  };
}

/** What one lookup found: what the query looks for, other records, no record, or a resolver error. */
type LookupResult = 'match' | 'records' | 'empty' | 'error';

async function classify<T>(run: () => Promise<T[]>, isMatch: (records: T[]) => boolean): Promise<LookupResult> {
  try {
    const records = await run();
    if (records.length === 0) return 'empty';
    return isMatch(records) ? 'match' : 'records';
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && NO_RECORD_CODES.includes(code) ? 'empty' : 'error';
  }
}

/** Up to five lookups about 100 ms apart; stops at the first match. */
async function query(lookup: () => Promise<LookupResult>, sleep: (ms: number) => Promise<void>): Promise<LookupResult[]> {
  const results: LookupResult[] = [];
  for (let i = 0; i < LOOKUPS_PER_QUERY; i++) {
    if (i > 0) await sleep(LOOKUP_GAP_MS);
    const result = await lookup();
    results.push(result);
    if (result === 'match') break;
  }
  return results;
}

export interface ChallengeCheckOptions {
  readonly lookup: DnsLookup;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The TXT query at `_tfd-challenge.<domain>`; a record whose strings,
 * joined, equal `tfd-verify=<token>` matches. The CNAME query at the same
 * name runs only when the TXT answer is empty or holds the token, so a
 * pass never rests on a CNAME (§3.4 step 5, the daily re-check's rule).
 *
 * Outcome: a CNAME found is `mismatch`. A TXT match is a pass only when a
 * CNAME lookup answered; a CNAME query that errored on every lookup makes
 * it `unresolved`. With no match, `mismatch` when any TXT lookup held
 * records, `unresolved` when every TXT lookup errored, `missing` otherwise
 * (a mix of errors and misses is a miss).
 */
export async function checkChallenge(domain: string, token: string, options: ChallengeCheckOptions): Promise<ChallengeOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const name = challengeRecordName(domain);
  const expected = challengeRecordValue(token);
  const txt = await query(() => classify(() => options.lookup.txt(name), (records) => records.some((r) => r.join('') === expected)), sleep);
  const cname = (): Promise<LookupResult[]> => query(() => classify(() => options.lookup.cname(name), () => true), sleep);

  if (txt.includes('match')) {
    const c = await cname();
    if (c.includes('match')) return 'mismatch';
    return c.every((r) => r === 'error') ? 'unresolved' : 'pass';
  }
  if (txt.includes('records')) return 'mismatch';
  if (txt.every((r) => r === 'error')) return 'unresolved';
  return (await cname()).includes('match') ? 'mismatch' : 'missing';
}
