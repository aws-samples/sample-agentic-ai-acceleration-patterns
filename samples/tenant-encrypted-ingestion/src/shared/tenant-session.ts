// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tenant-scoped sessions (spec P-2, §7.1, ADR-0003, M-11, M-13). Every call
 * made for a tenant is signed with credentials of a tenant role assumed
 * with a `TenantId` session tag; the wall is in that role's identity
 * policy, so this module passes no session policy (a session policy could
 * only narrow, and code that omitted it would hold the role's full
 * permissions).
 *
 * Freshness (spec §7.1 "Session lifetime"): sessions last 3600 s, the
 * role-chaining cap. A cached session is reused only while it has at least
 * `minRemainingMs` left: the API asks for the URL TTL plus 60 s before it
 * presigns, the processor for its own timeout T before it starts a run.
 * Sessions are cached per tenant, so the session name of a reused session
 * names the delivery or operation that first assumed it; the tenant part is
 * what attribution needs.
 */

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import { TENANT_TAG_KEY } from './constants';
import { isTenantId, sessionName } from './tenant-id';

export const SESSION_DURATION_SECONDS = 3600;

export interface TenantCredentials extends AwsCredentialIdentity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

export class TenantSessions {
  private readonly cache = new Map<string, TenantCredentials>();

  constructor(
    private readonly sts: STSClient,
    private readonly roleArn: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Credentials for `tenantId` with at least `minRemainingMs` left. The id
   * must already have passed the grammar; it is checked again here because
   * this is the last place before it becomes a tag.
   */
  async credentials(tenantId: string, suffix: string, minRemainingMs: number): Promise<TenantCredentials> {
    if (!isTenantId(tenantId)) {
      throw new Error('TenantSessions: tenant id fails the grammar (spec §7.0)');
    }
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && cached.expiration.getTime() - this.now() >= minRemainingMs) {
      return cached;
    }
    if (minRemainingMs > SESSION_DURATION_SECONDS * 1000) {
      throw new Error('TenantSessions: requested lifetime exceeds the one-hour session');
    }
    const response = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.roleArn,
        RoleSessionName: sessionName(tenantId, suffix),
        DurationSeconds: SESSION_DURATION_SECONDS,
        Tags: [{ Key: TENANT_TAG_KEY, Value: tenantId }],
      }),
    );
    const c = response.Credentials;
    if (c?.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.SessionToken === undefined || c.Expiration === undefined) {
      throw new Error('TenantSessions: AssumeRole returned no credentials');
    }
    const credentials: TenantCredentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
    this.cache.set(tenantId, credentials);
    return credentials;
  }

  /** Drops a cached session (after an AccessDenied that may be a stale session). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

/**
 * Per-tenant SDK clients over `TenantSessions`. A client is rebuilt when its
 * credentials are replaced, so a client never outlives its session.
 */
export class TenantClients<T> {
  private readonly clients = new Map<string, { credentials: TenantCredentials; client: T }>();

  constructor(
    private readonly sessions: TenantSessions,
    private readonly build: (credentials: TenantCredentials) => T,
  ) {}

  async client(tenantId: string, suffix: string, minRemainingMs: number): Promise<{ client: T; credentials: TenantCredentials }> {
    const credentials = await this.sessions.credentials(tenantId, suffix, minRemainingMs);
    const existing = this.clients.get(tenantId);
    if (existing !== undefined && existing.credentials === credentials) {
      return existing;
    }
    const entry = { credentials, client: this.build(credentials) };
    this.clients.set(tenantId, entry);
    return entry;
  }
}
