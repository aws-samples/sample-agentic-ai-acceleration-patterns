// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Per-tenant credentials for the tenant-user function (ADR-0026). Where the
 * stack configures a tenant-scoped role (pool-per-tenant), the function never
 * calls Cognito with its own role: it assumes the tenant-scoped role with the
 * authoriser's tenant id as the `TenantId` session tag, and the role's policy
 * allows the Cognito user actions only on a pool whose tenant tag equals that
 * session tag. IAM, not only the R-12 code check, then keeps tenant A's call
 * out of tenant B's pool.
 *
 * Credentials are cached in the execution environment per tenant and
 * refreshed about two minutes before they expire, with jitter so a burst of
 * warm environments does not refresh in lockstep. The cache is bounded; the
 * oldest tenant is evicted first. Nothing here logs a credential.
 */

import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import { isTenantId, TENANT_SESSION_SECONDS, TENANT_SESSION_TAG_KEY } from '../shared/constants';

export interface TenantCredentialCacheOptions {
  /** Only `send` is used, so tests can pass a stub. */
  readonly sts: Pick<STSClient, 'send'>;
  readonly roleArn: string;
  /** Refresh this long before expiry. Default 2 minutes. */
  readonly refreshMarginMs?: number;
  /** Up to this much extra, random, per fetch. Default 30 seconds. */
  readonly jitterMs?: number;
  /** Bound on cached tenants per execution environment. Default 500. */
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface Entry {
  readonly credentials: AwsCredentialIdentity;
  /** Epoch ms after which the entry is refreshed. */
  readonly refreshAt: number;
}

export class TenantCredentialCache {
  private readonly entries = new Map<string, Entry>();
  /** One STS call per tenant at a time. */
  private readonly inFlight = new Map<string, Promise<AwsCredentialIdentity>>();
  private readonly refreshMarginMs: number;
  private readonly jitterMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: TenantCredentialCacheOptions) {
    this.refreshMarginMs = options.refreshMarginMs ?? 120_000;
    this.jitterMs = options.jitterMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Credentials of the tenant-scoped role, tagged with `tenantId`. */
  async credentialsFor(tenantId: string): Promise<AwsCredentialIdentity> {
    // The authoriser only passes ULIDs; refuse anything else before it
    // becomes a session tag or a session name.
    if (!isTenantId(tenantId)) {
      throw new Error('Tenant-scoped credentials need a ULID tenant id');
    }
    const cached = this.entries.get(tenantId);
    if (cached !== undefined && this.now() < cached.refreshAt) {
      return cached.credentials;
    }
    const pending = this.inFlight.get(tenantId);
    if (pending !== undefined) {
      return pending;
    }
    const fetch = this.assume(tenantId).finally(() => this.inFlight.delete(tenantId));
    this.inFlight.set(tenantId, fetch);
    return fetch;
  }

  /** Number of cached tenants (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private async assume(tenantId: string): Promise<AwsCredentialIdentity> {
    const result = await this.options.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.options.roleArn,
        // ULIDs fit the session-name charset; the name shows in CloudTrail.
        RoleSessionName: `tenant-${tenantId}`,
        DurationSeconds: TENANT_SESSION_SECONDS,
        // The one session tag the role's trust policy accepts (ADR-0026).
        Tags: [{ Key: TENANT_SESSION_TAG_KEY, Value: tenantId }],
      }),
    );
    const c = result.Credentials;
    if (
      c?.AccessKeyId === undefined ||
      c.SecretAccessKey === undefined ||
      c.SessionToken === undefined ||
      c.Expiration === undefined
    ) {
      throw new Error('STS returned incomplete credentials');
    }
    const credentials: AwsCredentialIdentity = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
    const jitter = Math.floor(this.random() * this.jitterMs);
    const refreshAt = c.Expiration.getTime() - this.refreshMarginMs - jitter;
    // Re-insert so Map order is least-recently-fetched first, then evict.
    this.entries.delete(tenantId);
    this.entries.set(tenantId, { credentials, refreshAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return credentials;
  }
}

/**
 * Memoises one value per tenant, bounded like the credential cache. The
 * tenant-user function uses it to keep one Cognito client (and provisioner)
 * per tenant, each signing with that tenant's credentials.
 */
export function perTenant<T>(create: (tenantId: string) => T, maxEntries = 500): (tenantId: string) => T {
  const values = new Map<string, T>();
  return (tenantId: string) => {
    const existing = values.get(tenantId);
    if (existing !== undefined) {
      return existing;
    }
    const value = create(tenantId);
    values.set(tenantId, value);
    while (values.size > maxEntries) {
      values.delete(values.keys().next().value as string);
    }
    return value;
  };
}
