// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SCOPE_CATALOGUE_TTL_MS } from '../../src/shared/constants';
import type { ScopeCatalogueReader } from '../../src/shared/registry';
import { CachedScopeCatalogue, StaticScopeCatalogue } from '../../src/shared/scope-catalogue';

/**
 * The 60 s catalogue cache of ADR-0034: one read per TTL per container, a
 * failed read keeps the last catalogue, and a container that never read
 * successfully has an empty one.
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
    expect([...(await catalogue.names())]).toEqual(['a/b', 'c/d']);
    expect(r.calls).toBe(2);
  });

  it('is empty before the first successful read, and a failed cold read stays empty', async () => {
    const r = reader([new Error('throttled'), ['a/b']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    expect((await catalogue.names()).size).toBe(0);
    // Retried at the next call, not after the TTL: nothing was cached.
    expect([...(await catalogue.names())]).toEqual(['a/b']);
    expect(r.calls).toBe(2);
  });

  it('a failed refresh keeps the previous catalogue and retries at the next call', async () => {
    const r = reader([['a/b'], new Error('throttled'), ['c/d']]);
    const catalogue = new CachedScopeCatalogue(r, SCOPE_CATALOGUE_TTL_MS, clock);
    await catalogue.names();
    now += SCOPE_CATALOGUE_TTL_MS;
    expect([...(await catalogue.names())]).toEqual(['a/b']); // failed read, kept
    expect([...(await catalogue.names())]).toEqual(['c/d']); // retried at once
    expect(r.calls).toBe(3);
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
