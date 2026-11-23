// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Credentials of the tool tenant role for one tenant (spec §3.2): one
 * `sts:AssumeRole` with `sts:TagSession` carrying `TenantId`. The role's
 * policy reads that tag, so the credentials reach only this tenant's
 * `inputs/` and `outputs/` prefixes, registry rows and (`nitro`) tasks.
 * Cached per tenant inside one warm Lambda environment until two minutes
 * before they expire (ADR-0032).
 */

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { TenantCredentials } from '../backend';
import { TENANT_TAG } from '../env';

export type CredentialSource = (tenantId: string) => Promise<TenantCredentials>;

const SESSION_SECONDS = 900;
const REFRESH_MARGIN_MS = 120_000;
/** Distinct tenants one warm environment keeps credentials for. */
const CACHE_LIMIT = 256;

export function stsCredentialSource(
  roleArn: string,
  client: Pick<STSClient, 'send'> = new STSClient({}),
  now: () => number = Date.now,
): CredentialSource {
  const cache = new Map<string, TenantCredentials>();
  return async (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit?.expiration !== undefined && hit.expiration.getTime() - now() > REFRESH_MARGIN_MS) return hit;
    const out = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      // A session name is a fixed label; the tenant travels as the session tag only.
      RoleSessionName: 'run-code',
      DurationSeconds: SESSION_SECONDS,
      Tags: [{ Key: TENANT_TAG, Value: tenantId }],
    }));
    const c = out.Credentials;
    if (c?.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.SessionToken === undefined) {
      throw new Error('AssumeRole returned no credentials');
    }
    const creds: TenantCredentials = {
      tenantId,
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
    cache.delete(tenantId);
    cache.set(tenantId, creds);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return creds;
  };
}
