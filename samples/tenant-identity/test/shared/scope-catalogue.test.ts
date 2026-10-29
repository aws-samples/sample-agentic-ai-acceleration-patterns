// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SCOPE_CATALOGUE_MAX_AGE_MS, SCOPE_CATALOGUE_RETRY_MS, SCOPE_CATALOGUE_TTL_MS } from '../../src/shared/constants';
import type { ScopeCatalogueReader } from '../../src/shared/registry';
import { CachedScopeCatalogue, StaticScopeCatalogue } from '../../src/shared/scope-catalogue';

/**
 * The 60 s catalogue cache of ADR-0034: one read per TTL per container, a
 * failed read keeps the last catalogue and backs off 5 s before the next
 * read (M-36), and a container that never read successfully has an empty one.
 * Refreshes are stale-while-revalidate: only the cold-start read is awaited;
 * a stale warm cache is served at once while one background read runs, and
 * a cache older than the max age reads as empty (fail closed).
 */

function reader(results: Array<string[] | Error>): ScopeCatalogueReader & { calls: number } {
  const queue = [...results];
  const r = {
    calls: 0,
    listScopeNames: async () => {
      r.calls += 1;
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('no more results scripted');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
  return r;
}

/** A reader whose reads never settle until `release` is called, counting them. */
function blockingReader(): ScopeCatalogueReader & { calls: number; release: (names: string[]) => void } {
  let resolve: ((names: string[]) => void) | undefined;
  const r = {
    calls: 0,
    release: (names: string[]) => resolve?.(names),
    listScopeNames: () => {
      r.calls += 1;
      return new Promise<string[]>((res) => {
        resolve = res;
      });
    },
  };
  return r;
}

/** Lets a background refresh (an un-awaited promise chain) run to completion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CachedScopeCatalogue (ADR-0034)', () => {
  let now = 1_000_000;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads once and serves the cache until the TTL passes', async () => {
    const r = reader([['a/b'], ['a/b', 'c/d']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    now += SCOPE_CATALOGUE_TTL_MS - 1;
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(1);
    now += 1;
    // Stale: the old catalogue is served at once and one read starts.
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(2);
    await settle();
    expect([...(await catalogue.names())]).toEqual(['a/b', 'c/d']);
    expect(r.calls).toBe(2);
  });

  it('is empty before the first successful read, and a failed cold read stays empty until the backoff passes', async () => {
    const r = reader([new Error('throttled'), ['a/b']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    expect((await catalogue.names()).size).toBe(0);
    // Within the backoff every call serves the empty catalogue with no read
    // (M-36): an outage costs one table call per 5 s, not one per token.
    now += SCOPE_CATALOGUE_RETRY_MS - 1;
    expect((await catalogue.names()).size).toBe(0);
    expect(r.calls).toBe(1);
    // Retried once the backoff has passed, not after the TTL: nothing was cached.
    now += 1;
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(2);
  });

  it('a failed refresh keeps the previous catalogue and retries after the backoff', async () => {
    const r = reader([['a/b'], new Error('throttled'), ['c/d']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    await catalogue.names();
    now += SCOPE_CATALOGUE_TTL_MS;
    expect([...(await catalogue.names())]).toEqual(['a/b']); // stale, served; background read fails
    await settle();
    expect([...(await catalogue.names())]).toEqual(['a/b']); // in backoff, no read
    expect(r.calls).toBe(2);
    now += SCOPE_CATALOGUE_RETRY_MS;
    expect([...(await catalogue.names())]).toEqual(['a/b']); // retried after 5 s, still served stale
    expect(r.calls).toBe(3);
    await settle();
    expect([...(await catalogue.names())]).toEqual(['c/d']); // the retry's result
    expect(r.calls).toBe(3);
  });

  it('a successful read clears the backoff, so the next refresh waits the TTL, not the backoff', async () => {
    const r = reader([new Error('throttled'), ['a/b'], ['c/d']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    await catalogue.names();
    now += SCOPE_CATALOGUE_RETRY_MS;
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    now += SCOPE_CATALOGUE_TTL_MS - 1;
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(2);
    now += 1;
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(3);
    await settle();
    expect([...(await catalogue.names())]).toEqual(['c/d']);
  });

  it('the backoff is shorter than the TTL, so a stale catalogue is never kept for an extra period', () => {
    expect(SCOPE_CATALOGUE_RETRY_MS).toBe(5_000);
    expect(SCOPE_CATALOGUE_RETRY_MS).toBeLessThan(SCOPE_CATALOGUE_TTL_MS);
  });

  it('concurrent callers on a stale cache share one read', async () => {
    const r = reader([['a/b']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    const [x, y, z] = await Promise.all([catalogue.names(), catalogue.names(), catalogue.names()]);
    expect([...x]).toEqual(['a/b']);
    expect(y).toBe(x);
    expect(z).toBe(x);
    expect(r.calls).toBe(1);
  });

  describe('stale-while-revalidate', () => {
    it('cold start awaits the first read', async () => {
      const r = blockingReader();
      const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
      let resolved: ReadonlySet<string> | undefined;
      const pending = catalogue.names().then((names) => {
        resolved = names;
      });
      await settle();
      expect(r.calls).toBe(1);
      expect(resolved).toBeUndefined(); // still waiting on the registry
      r.release(['a/b']);
      await pending;
      expect([...resolved!]).toEqual(['a/b']);
    });

    it('a stale warm cache is served immediately while the read is still in flight', async () => {
      const r = blockingReader();
      const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
      const first = catalogue.names();
      r.release(['a/b']);
      await first;
      now += SCOPE_CATALOGUE_TTL_MS;
      // The reader never resolves this time: the call must not wait on it.
      expect([...(await catalogue.names())]).toEqual(['a/b']);
      expect([...(await catalogue.names())]).toEqual(['a/b']);
      expect(r.calls).toBe(2); // one shared background read, not one per call
      r.release(['c/d']);
      await settle();
      expect([...(await catalogue.names())]).toEqual(['c/d']);
    });

    it('a cache older than the max age reads as empty (fail closed) while the refresh continues', async () => {
      const r = blockingReader();
      const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
      const first = catalogue.names();
      r.release(['a/b']);
      await first;
      now += SCOPE_CATALOGUE_MAX_AGE_MS - 1;
      expect([...(await catalogue.names())]).toEqual(['a/b']); // stale but within the max age
      expect(r.calls).toBe(2);
      now += 1;
      expect((await catalogue.names()).size).toBe(0); // too old: empty, not the stale set
      expect(r.calls).toBe(2); // the background read is still the one in flight
      r.release(['c/d']);
      await settle();
      expect([...(await catalogue.names())]).toEqual(['c/d']); // a successful read restores service
    });

    it('the max age is ten TTLs', () => {
      expect(SCOPE_CATALOGUE_MAX_AGE_MS).toBe(10 * SCOPE_CATALOGUE_TTL_MS);
    });
  });

  it('never throws and logs only the error class name', async () => {
    const boom = new Error('the table name must never appear here');
    boom.name = 'ResourceNotFoundException';
    const catalogue = new CachedScopeCatalogue(reader([boom]), SCOPE_CATALOGUE_TTL_MS, clock);
    await expect(catalogue.names()).resolves.toBeDefined();
    const logged = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('ResourceNotFoundException');
    expect(logged).not.toContain('table name');
  });
});

describe('StaticScopeCatalogue', () => {
  it('returns the fixed set', async () => {
    expect([...(await new StaticScopeCatalogue(['a/b', 'a/b', 'c/d']).names())]).toEqual(['a/b', 'c/d']);
  });
});
