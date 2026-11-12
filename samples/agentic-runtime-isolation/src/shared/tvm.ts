// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token vending machine (spec C-7, P-8, ADR-0012), shared by both
 * ingress Lambdas. It turns the claims the verifier has just validated into
 * session tags, assumes the tenant role with `sts:AssumeRole` + `TagSession`,
 * and caches the result per tag set until two minutes before expiry (with
 * jitter, so a fleet of containers does not refresh in lock step). The
 * cache is bounded (ADR-0022): at most `cacheMaxEntries` tag sets, least
 * recently used evicted first, expired entries dropped on the way, and
 * concurrent misses for one tag set share one STS call. A hot tag set is
 * refreshed ahead of time (ADR-0023): in the two minutes before the margin
 * a request is served from the cache and one STS call runs in the
 * background, so a busy tenant never waits for STS after its first request.
 * It never logs a value: not a tag, not a key, not a token. How the
 * credentials reach the backend is the backend's concern (src/backend).
 */

import { AssumeRoleCommand, STSClient, type Tag } from '@aws-sdk/client-sts';
import type { TvmConfig } from './config';
import { sharedHandler } from './http';
import { errorName, log } from './logger';
import type { VerifiedClaims } from './verifier';

/** Reserved tag keys the ingress always sets or owns (spec §3.3). */
export const TENANT_TAG_KEY = 'TenantId';
export const USER_TAG_KEY = 'UserId';

/** Refresh when less than this remains (ADR-0012: two minutes). */
export const REFRESH_MARGIN_MS = 120_000;
/** Up to this much extra margin, chosen once per cache entry. */
export const REFRESH_JITTER_MS = 30_000;
/** Within this much of the margin, a hit is served and a refresh starts in the background (ADR-0023). */
export const REFRESH_AHEAD_MS = 120_000;

/** Default bound on cached tag sets per ingress instance (ADR-0022). */
export const DEFAULT_CACHE_MAX_ENTRIES = 1000;

/** A `tvm.claimTags` claim that the token does not carry: the request fails with 403. */
export class ClaimMissingError extends Error {
  constructor(readonly tagKey: string) {
    super('claim_missing');
    this.name = 'ClaimMissingError';
  }
}

export interface VendedCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** ISO 8601. */
  readonly expiration: string;
}

export interface VendResult {
  readonly credentials: VendedCredentials;
  /** True when the credentials came from the cache (no STS call). */
  readonly cached: boolean;
}

interface CacheEntry {
  readonly credentials: VendedCredentials;
  readonly expiresAt: number;
  readonly margin: number;
}

/**
 * The session tags for a set of claims: `TenantId` always, `UserId` on
 * opt-in, then `claimTags` (tag key to claim name). A listed claim that is
 * missing or not a string throws ClaimMissingError. Sorted by key so the
 * cache key is stable.
 */
export function sessionTags(claims: VerifiedClaims, config: Pick<TvmConfig, 'includeUserIdTag' | 'claimTags'>): Tag[] {
  const tags: Tag[] = [{ Key: TENANT_TAG_KEY, Value: claims.tenantId }];
  if (config.includeUserIdTag) {
    tags.push({ Key: USER_TAG_KEY, Value: claims.sub });
  }
  for (const [tagKey, claimName] of Object.entries(config.claimTags)) {
    if (tagKey === TENANT_TAG_KEY || tagKey === USER_TAG_KEY) {
      throw new Error(`tvm.claimTags: ${tagKey} is a reserved tag key`);
    }
    const value = claims.claims[claimName];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ClaimMissingError(tagKey);
    }
    tags.push({ Key: tagKey, Value: value });
  }
  return tags.sort((a, b) => (a.Key! < b.Key! ? -1 : 1));
}

/** STS role session names allow `[\w+=,.@-]{2,64}`; anything else becomes `_`. */
export function roleSessionName(tenantId: string): string {
  const safe = tenantId.replace(/[^\w+=,.@-]/g, '_');
  return `tenant-${safe}`.slice(0, 64);
}

export interface TokenVendingMachineDependencies {
  readonly sts?: STSClient;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class TokenVendingMachine {
  /** Insertion order is recency order: a hit is re-inserted, the first key is the least recently used. */
  private readonly cache = new Map<string, CacheEntry>();
  /** One in-flight AssumeRole per tag set (single flight): concurrent misses await the same call. */
  private readonly inFlight = new Map<string, Promise<VendedCredentials>>();
  private readonly sts: STSClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxEntries: number;

  constructor(private readonly config: TvmConfig, deps: TokenVendingMachineDependencies = {}) {
    this.sts = deps.sts ?? new STSClient({ requestHandler: sharedHandler() });
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.maxEntries = config.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('TokenVendingMachine: cacheMaxEntries must be a positive integer');
    }
  }

  /** Tenant-scoped credentials for these claims, from the cache when still fresh. */
  async vend(claims: VerifiedClaims): Promise<VendResult> {
    const tags = sessionTags(claims, this.config);
    const key = JSON.stringify(tags);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      const remaining = hit.expiresAt - this.now();
      if (remaining > hit.margin) {
        this.cache.set(key, hit);
        if (remaining <= hit.margin + REFRESH_AHEAD_MS) {
          this.refreshAhead(claims, tags, key);
        }
        return { credentials: hit.credentials, cached: true };
      }
    }
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return { credentials: await pending, cached: true };
    }
    return { credentials: await this.singleFlight(claims, tags, key), cached: false };
  }

  /** One AssumeRole per tag set at a time; a concurrent miss awaits the same call. */
  private singleFlight(claims: VerifiedClaims, tags: Tag[], key: string): Promise<VendedCredentials> {
    const call = this.assume(claims, tags, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  /**
   * Starts a refresh for a still-fresh entry without waiting for it. A
   * failure is logged by name only; the entry stays and the next request
   * past the margin retries on the request path as before.
   */
  private refreshAhead(claims: VerifiedClaims, tags: Tag[], key: string): void {
    if (this.inFlight.has(key)) {
      return;
    }
    this.singleFlight(claims, tags, key).catch((error) => {
      log.warn('tvm refresh-ahead failed; the entry stays until its margin', { error: errorName(error) });
    });
  }

  private async assume(claims: VerifiedClaims, tags: Tag[], key: string): Promise<VendedCredentials> {
    const response = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.config.roleArn,
        RoleSessionName: roleSessionName(claims.tenantId),
        DurationSeconds: this.config.durationSeconds,
        Tags: tags,
      }),
    );
    const c = response.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error('AssumeRole returned no credentials');
    }
    const credentials: VendedCredentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: new Date(c.Expiration).toISOString(),
    };
    this.store(key, {
      credentials,
      expiresAt: new Date(c.Expiration).getTime(),
      margin: REFRESH_MARGIN_MS + Math.floor(this.random() * REFRESH_JITTER_MS),
    });
    return credentials;
  }

  /** Adds an entry, then evicts expired entries and the least recently used until within the bound. */
  private store(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size <= this.maxEntries) {
      return;
    }
    const now = this.now();
    for (const [k, e] of this.cache) {
      if (e.expiresAt - now <= e.margin) {
        this.cache.delete(k);
      }
    }
    for (const k of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) {
        break;
      }
      this.cache.delete(k);
    }
  }

  /** Number of cached tag sets (for tests). */
  get size(): number {
    return this.cache.size;
  }
}
