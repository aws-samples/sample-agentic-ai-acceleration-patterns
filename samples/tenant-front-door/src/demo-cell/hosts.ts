// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The hosts check (spec §3.5, §6.1): is the verified tenant one this cell
 * hosts? The cell knows its tenants from its own account's namespace,
 * `/application-plane/tenants/<tenantId>/<applicationId>/*`, which the
 * tenant's deployment script writes (control-plane spec §6.2). A tenant is
 * hosted when any parameter exists under it. The path is built from the
 * verified claim in its control-plane form (upper case) through
 * `paramTenantNamespace`, never from the lower-case `x-tenant-route` hint,
 * because SSM names are case-sensitive.
 *
 * Answers are cached per container for `CACHE_TTL_MS`, so a burst from one
 * tenant makes one SSM call, not one per request (SSM's
 * `GetParametersByPath` has a low per-account rate). shortcut: a tenant
 * removed from the cell is still served by a warm container for up to
 * 60 s, and a new tenant may be refused for up to 60 s after its first
 * refused call; upgrade to a shorter TTL or an event-driven flush if that
 * window matters.
 *
 * An SSM error is not cached and is thrown: the check fails closed.
 */

import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { paramTenantNamespace } from '../shared/contracts';

export const CACHE_TTL_MS = 60_000;
/** Bounds the cache; the oldest entry goes first. */
export const CACHE_MAX_ENTRIES = 1000;
/** `GetParametersByPath` may answer a page with no parameters and a `NextToken`; follow at most this many. */
export const MAX_PAGES = 5;

export interface HostsCheckDependencies {
  readonly ssm?: Pick<SSMClient, 'send'>;
  readonly now?: () => number;
}

export class HostsCheck {
  private readonly ssm: Pick<SSMClient, 'send'>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { hosted: boolean; expires: number }>();

  constructor(private readonly applicationId: string, deps: HostsCheckDependencies = {}) {
    this.ssm = deps.ssm ?? new SSMClient({});
    this.now = deps.now ?? Date.now;
  }

  /** True when the cell's account holds the verified tenant's namespace for this application. */
  async hosts(verifiedTenantId: string): Promise<boolean> {
    // GetParametersByPath takes the hierarchy without its trailing slash.
    const path = paramTenantNamespace(verifiedTenantId, this.applicationId).replace(/\/$/, '');
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.expires > this.now()) {
      return cached.hosted;
    }
    const hosted = await this.lookUp(path);
    this.cache.delete(path);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(path, { hosted, expires: this.now() + CACHE_TTL_MS });
    return hosted;
  }

  private async lookUp(path: string): Promise<boolean> {
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await this.ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: true, MaxResults: 1, NextToken: nextToken }));
      if ((out.Parameters?.length ?? 0) > 0) {
        return true;
      }
      nextToken = out.NextToken;
      if (nextToken === undefined) {
        return false;
      }
    }
    return false;
  }
}
