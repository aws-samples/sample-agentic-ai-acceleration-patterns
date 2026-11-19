// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The domain challenge lookup (spec §3.4 step 5 sub-step 2, ADR-0018), the
 * same for the registrar's checks and the sweeper's daily re-check. It
 * resolves `_tfd-challenge.<d>` with the function's default resolver.
 *
 * Each query, TXT or CNAME, makes up to five lookups about 100 ms apart
 * and stops at the first lookup that finds what it looks for: a TXT record
 * whose strings, joined, equal `tfd-verify=<dk>`, or a CNAME. Each lookup
 * is one try, abandoned after 1 s of wall time. A query with no such
 * lookup takes its outcome from the lookups that got an answer: records
 * (TXT, or a CNAME) make it a mismatch, otherwise it is missing. It is
 * unresolved only when every lookup errors, so a mix of errors and misses
 * is a miss. A query takes at most 5 × 1 s + 4 × 100 ms = 5.4 s.
 *
 * CNAME is queried only when the TXT answer is empty or holds the token,
 * so a pass never rests on a CNAME, and a CNAME at the name is a mismatch
 * whatever its target holds. Nothing here logs: the token never leaves
 * this module.
 */

import { Resolver } from 'node:dns/promises';
import { CHALLENGE_RECORD_PREFIX, CHALLENGE_VALUE_PREFIX } from './contracts';

export const LOOKUPS_PER_QUERY = 5;
export const LOOKUP_GAP_MS = 100;
export const LOOKUP_LIMIT_MS = 1_000;

/** `pass`, or the registrar's `challenge` value for any other answer (§3.4 step 5 sub-step 2). */
export type ChallengeOutcome = 'pass' | 'missing' | 'mismatch' | 'unresolved';

/** One lookup's answer. `none` is NXDOMAIN or no record of the type; `error` is anything else, a timeout included. */
export type LookupAnswer =
  | { readonly kind: 'txt'; readonly records: readonly (readonly string[])[] }
  | { readonly kind: 'cname'; readonly records: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'error' };

/** Makes one lookup of one try. */
export type Lookup = (type: 'TXT' | 'CNAME', name: string) => Promise<LookupAnswer>;

export interface ChallengeCheckDeps {
  readonly lookup: Lookup;
  readonly sleep: (ms: number) => Promise<void>;
}

/** NXDOMAIN and NODATA: the resolver answered, with nothing of this type. */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/** The resolver interface `nodeLookup` uses: what `node:dns/promises` `Resolver` offers. */
export interface ResolverLike {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  cancel(): void;
}

/**
 * One lookup with a fresh default-resolver `Resolver` built with
 * `timeout: 1000, tries: 1`: a plain `timeout` is per try, and the default
 * lookup inherits several attempts from `/etc/resolv.conf`. A timer also
 * cancels the query once 1 s of wall time has passed.
 */
export function nodeLookup(
  newResolver: () => ResolverLike = () => new Resolver({ timeout: LOOKUP_LIMIT_MS, tries: 1 }),
  limitMs: number = LOOKUP_LIMIT_MS,
): Lookup {
  return async (type, name) => {
    const resolver = newResolver();
    let timer: NodeJS.Timeout | undefined;
    const abandoned = new Promise<LookupAnswer>((resolve) => {
      timer = setTimeout(() => {
        resolver.cancel();
        resolve({ kind: 'error' });
      }, limitMs);
    });
    const answered = (async (): Promise<LookupAnswer> => {
      try {
        if (type === 'TXT') return { kind: 'txt', records: await resolver.resolveTxt(name) };
        return { kind: 'cname', records: await resolver.resolveCname(name) };
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        return typeof code === 'string' && NO_RECORD_CODES.has(code) ? { kind: 'none' } : { kind: 'error' };
      }
    })();
    try {
      return await Promise.race([answered, abandoned]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const defaultChallengeCheckDeps: ChallengeCheckDeps = {
  lookup: nodeLookup(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** `_tfd-challenge.<d>`. */
export function challengeRecordName(domain: string): string {
  return `${CHALLENGE_RECORD_PREFIX}${domain}`;
}

type QueryResult = 'found' | 'records' | 'none' | 'error';

/** Up to five lookups of one type; stops at the first that `isMatch` accepts. */
async function query(
  deps: ChallengeCheckDeps,
  type: 'TXT' | 'CNAME',
  name: string,
  isMatch: (answer: LookupAnswer) => boolean,
): Promise<QueryResult> {
  let records = false;
  let none = false;
  for (let i = 0; i < LOOKUPS_PER_QUERY; i++) {
    if (i > 0) await deps.sleep(LOOKUP_GAP_MS);
    const answer = await deps.lookup(type, name);
    if (isMatch(answer)) return 'found';
    if ((answer.kind === 'txt' || answer.kind === 'cname') && answer.records.length > 0) records = true;
    else if (answer.kind !== 'error') none = true;
  }
  if (records) return 'records';
  return none ? 'none' : 'error';
}

/**
 * Checks the challenge record of `domain` for `token` (§3.4 step 5 sub-step
 * 2, and the daily re-check). A resolver error is never a pass.
 */
export async function checkChallenge(domain: string, token: string, deps: ChallengeCheckDeps = defaultChallengeCheckDeps): Promise<ChallengeOutcome> {
  const name = challengeRecordName(domain);
  const expected = `${CHALLENGE_VALUE_PREFIX}${token}`;
  const txt = await query(deps, 'TXT', name, (a) => a.kind === 'txt' && a.records.some((strings) => strings.join('') === expected));
  if (txt === 'records') return 'mismatch';
  if (txt === 'error') return 'unresolved';

  const cname = await query(deps, 'CNAME', name, (a) => a.kind === 'cname' && a.records.length > 0);
  if (cname === 'found') return 'mismatch';
  if (txt === 'found') {
    // Spec §3.4 step 5 does not name the outcome of a token match whose
    // CNAME query only errors. A resolver error is never a pass, so it is
    // unresolved.
    return cname === 'none' ? 'pass' : 'unresolved';
  }
  // The TXT answer was empty: the name holds no TXT record and no CNAME
  // was found, whether or not the CNAME lookups errored (a mix of errors
  // and misses is a miss).
  return 'missing';
}
