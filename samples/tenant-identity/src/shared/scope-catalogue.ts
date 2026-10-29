// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SCOPE_CATALOGUE_RETRY_MS, SCOPE_CATALOGUE_TTL_MS } from './constants';
import { errorName, log } from './logger';
import type { ScopeCatalogueReader } from './registry';

/**
 * The scope catalogue as the token path sees it (ADR-0034): the set of
 * registered scope names, read from the registry and kept for 60 s per
 * Lambda container. The trigger and the token exchange hold one instance
 * each for the life of the container.
 *
 * Failure behaviour, from the ADR: a read that fails keeps the previous
 * catalogue and is retried after a short backoff (`SCOPE_CATALOGUE_RETRY_MS`,
 * M-36), not on every call; a container that has never read successfully
 * has an EMPTY catalogue, so narrowing is refused with `invalid_scope` and
 * an un-narrowed token carries no scope, rather than a token being issued on
 * a guess. Only the error's class name is logged.
 */
export interface ScopeCatalogue {
  /** The registered names, as fresh as the cache allows. Never throws. */
  names(): Promise<ReadonlySet<string>>;
}

export class CachedScopeCatalogue implements ScopeCatalogue {
  private cached: ReadonlySet<string> = new Set();
  private readAt: number | undefined;
  /** When the last read failed, the earliest time the next one may start. */
  private retryAt: number | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly reader: ScopeCatalogueReader,
    private readonly ttlMs: number = SCOPE_CATALOGUE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly retryMs: number = SCOPE_CATALOGUE_RETRY_MS,
  ) {}

  async names(): Promise<ReadonlySet<string>> {
    if (this.isStale() && !this.inBackoff()) {
      // One read at a time per container: concurrent callers on a stale
      // cache share the in-flight read instead of each querying the table.
      this.inFlight ??= this.refresh().finally(() => {
        this.inFlight = undefined;
      });
      await this.inFlight;
    }
    return this.cached;
  }

  private isStale(): boolean {
    return this.readAt === undefined || this.now() - this.readAt >= this.ttlMs;
  }

  private inBackoff(): boolean {
    return this.retryAt !== undefined && this.now() < this.retryAt;
  }

  private async refresh(): Promise<void> {
    try {
      this.cached = new Set(await this.reader.listScopeNames());
      this.readAt = this.now();
      this.retryAt = undefined;
    } catch (error) {
      // Keep the last good catalogue (possibly the empty cold-start one):
      // readAt is left as it was, so a stale cache stays stale, not
      // refreshed by a failure. The next read waits `retryMs` (M-36), so an
      // outage costs one table call per backoff period, not one per token.
      this.retryAt = this.now() + this.retryMs;
      log.error('scope catalogue read failed; keeping the previous catalogue', { errorName: errorName(error) });
    }
  }
}

/** A fixed catalogue, for tests and for callers that read the registry once per request. */
export class StaticScopeCatalogue implements ScopeCatalogue {
  private readonly set: ReadonlySet<string>;

  constructor(names: Iterable<string>) {
    this.set = new Set(names);
  }

  async names(): Promise<ReadonlySet<string>> {
    return this.set;
  }
}
