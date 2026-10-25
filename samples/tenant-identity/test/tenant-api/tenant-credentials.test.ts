// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { perTenant, TenantCredentialCache } from '../../src/tenant-api/tenant-credentials';

/**
 * Unit tests for the tenant-scoped credential cache (ADR-0026): the session
 * tag carries the tenant, the session lasts 900 s, credentials are cached per
 * tenant and refreshed two minutes (plus jitter) before they expire, one STS
 * call per tenant at a time, and the cache is bounded.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sts: any = mockClient(STSClient as any);
const ROLE = 'arn:aws:iam::123456789012:role/TenantScopedRole';
const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';
const TENANT_B = '01HZX9ABCDEFGHJKMNPQRSTVWY';
const T0 = Date.parse('2026-10-22T12:00:00.000Z');

let issued = 0;
function credentialsExpiringAt(ms: number) {
  issued++;
  return {
    Credentials: {
      AccessKeyId: `ASIA${issued}`,
      SecretAccessKey: 'synthetic-secret',
      SessionToken: 'synthetic-session',
      Expiration: new Date(ms),
    },
  };
}

function cache(over: { now?: () => number; random?: () => number; maxEntries?: number } = {}): TenantCredentialCache {
  return new TenantCredentialCache({
    sts: new STSClient({ region: 'eu-central-1' }),
    roleArn: ROLE,
    now: over.now ?? (() => T0),
    random: over.random ?? (() => 0),
    maxEntries: over.maxEntries,
  });
}

beforeEach(() => {
  sts.reset();
  issued = 0;
  sts.on(AssumeRoleCommand).callsFake(() => credentialsExpiringAt(T0 + 900_000));
});

describe('TenantCredentialCache (ADR-0026)', () => {
  it('assumes the role with the tenant as the only session tag, for 900 seconds', async () => {
    const creds = await cache().credentialsFor(TENANT_A);

    const calls = sts.commandCalls(AssumeRoleCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      RoleArn: ROLE,
      RoleSessionName: `tenant-${TENANT_A}`,
      DurationSeconds: 900,
      Tags: [{ Key: 'TenantId', Value: TENANT_A }],
    });
    expect(creds).toEqual({
      accessKeyId: 'ASIA1',
      secretAccessKey: 'synthetic-secret',
      sessionToken: 'synthetic-session',
      expiration: new Date(T0 + 900_000),
    });
  });

  it('reuses cached credentials until two minutes before expiry, then refreshes', async () => {
    let now = T0;
    const c = cache({ now: () => now });
    const first = await c.credentialsFor(TENANT_A);

    now = T0 + 900_000 - 120_001; // just inside the window: still cached
    expect(await c.credentialsFor(TENANT_A)).toBe(first);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);

    now = T0 + 900_000 - 120_000; // at the margin: refresh
    const second = await c.credentialsFor(TENANT_A);
    expect(second).not.toBe(first);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it('jitter moves the refresh earlier, by up to 30 seconds', async () => {
    let now = T0;
    const c = cache({ now: () => now, random: () => 0.999999 });
    await c.credentialsFor(TENANT_A);
    // refreshAt = expiry - 120 s - floor(0.999999 * 30 s) = expiry - 149.999 s
    now = T0 + 900_000 - 150_001;
    await c.credentialsFor(TENANT_A);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    now = T0 + 900_000 - 149_999;
    await c.credentialsFor(TENANT_A);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it('keys the cache by tenant: B never gets A\'s session', async () => {
    const c = cache();
    const a = await c.credentialsFor(TENANT_A);
    const b = await c.credentialsFor(TENANT_B);
    expect(b).not.toBe(a);
    const tags = sts.commandCalls(AssumeRoleCommand).map((call: any) => call.args[0].input.Tags[0].Value);
    expect(tags).toEqual([TENANT_A, TENANT_B]);
  });

  it('makes one STS call for concurrent requests for the same tenant', async () => {
    const c = cache();
    const [x, y] = await Promise.all([c.credentialsFor(TENANT_A), c.credentialsFor(TENANT_A)]);
    expect(x).toBe(y);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it('does not cache a failure: the next call retries', async () => {
    sts
      .on(AssumeRoleCommand)
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }))
      .callsFake(() => credentialsExpiringAt(T0 + 900_000));
    const c = cache();
    await expect(c.credentialsFor(TENANT_A)).rejects.toMatchObject({ name: 'Throttling' });
    await expect(c.credentialsFor(TENANT_A)).resolves.toMatchObject({ accessKeyId: expect.any(String) });
    expect(c.size).toBe(1);
  });

  it('refuses a tenant id that is not a ULID, before calling STS', async () => {
    await expect(cache().credentialsFor('tenant-a; drop')).rejects.toThrow(/ULID/);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('refuses incomplete credentials', async () => {
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'ASIA', SecretAccessKey: 's' } });
    await expect(cache().credentialsFor(TENANT_A)).rejects.toThrow(/incomplete/);
  });

  it('evicts the oldest tenant past maxEntries', async () => {
    const c = cache({ maxEntries: 1 });
    await c.credentialsFor(TENANT_A);
    await c.credentialsFor(TENANT_B);
    expect(c.size).toBe(1);
    await c.credentialsFor(TENANT_A); // A was evicted: a fresh STS call
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(3);
  });
});

describe('perTenant (ADR-0026)', () => {
  it('builds one value per tenant and reuses it', () => {
    const create = jest.fn((tenantId: string) => ({ tenantId }));
    const forTenant = perTenant(create);
    expect(forTenant(TENANT_A)).toBe(forTenant(TENANT_A));
    expect(forTenant(TENANT_B)).toEqual({ tenantId: TENANT_B });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('is bounded: the oldest value is rebuilt after eviction', () => {
    const create = jest.fn((tenantId: string) => ({ tenantId }));
    const forTenant = perTenant(create, 1);
    const first = forTenant(TENANT_A);
    forTenant(TENANT_B);
    expect(forTenant(TENANT_A)).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
