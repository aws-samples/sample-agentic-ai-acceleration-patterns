// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SCOPE_CATALOGUE_MAX_AGE_MS, SCOPE_CATALOGUE_RETRY_MS, SCOPE_CATALOGUE_TTL_MS } from './constants';
import { errorName, log } from './logger';
import type { ScopeCatalogueReader } from './registry';

/**
 * The scope catalogue as the token path sees it (ADR-0034): the set of
 * registered scope names, read from the registry and kept for 60 s per
 * Lambda container. The trigger and the token exchange hold one instance
 * each for the life of the container.
 *
 * Refresh behaviour: stale-while-revalidate. Only the first read of a
 * container (cold start) is awaited; once a catalogue has been read, a call
 * past the TTL returns the cached set at once and starts one shared
 * background read, so the registry's latency never lands on a token
 * request. A cache older than `SCOPE_CATALOGUE_MAX_AGE_MS` (ten TTLs of
 * failed reads) is no longer served: the catalogue reads as EMPTY (fail
 * closed) while the refresh keeps being retried.
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

const EMPTY: ReadonlySet<string> = new Set();

export class CachedScopeCatalogue implements ScopeCatalogue {
  private cached: ReadonlySet<string> = EMPTY;
  private readAt: number | undefined;
  /** When the last read failed, the earliest time the next one may start. */
  private retryAt: number | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly reader: ScopeCatalogueReader,
    private readonly ttlMs: number = SCOPE_CATALOGUE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly retryMs: number = SCOPE_CATALOGUE_RETRY_MS,
    private readonly maxAgeMs: number = SCOPE_CATALOGUE_MAX_AGE_MS,
  ) {}

  async names(): Promise<ReadonlySet<string>> {
    if (this.readAt === undefined) {
      // Cold start: nothing to serve yet, so the one read is awaited. Within
      // a failed read's backoff the empty catalogue is served with no read.
      if (!this.inBackoff()) {
        await this.startRefresh();
      }
      return this.cached;
    }
    const age = this.now() - this.readAt;
    if (age >= this.ttlMs && !this.inBackoff()) {
      // Stale: refresh in the background and answer from the cache now.
      // `refresh` never rejects, so the un-awaited promise cannot leak an
      // unhandled rejection.
      void this.startRefresh();
    }
    // Fail closed once the cache is older than the registry outage the
    // design tolerates: an empty catalogue, never a ten-minute-old one.
    return age >= this.maxAgeMs ? EMPTY : this.cached;
  }

  /** One read at a time per container: concurrent callers share the in-flight read. */
  private startRefresh(): Promise<void> {
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
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
