// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import type { TvmConfig } from '../../src/shared/config';
import {
  ClaimMissingError,
  DEFAULT_CACHE_MAX_ENTRIES,
  REFRESH_AHEAD_MS,
  REFRESH_JITTER_MS,
  REFRESH_MARGIN_MS,
  roleSessionName,
  sessionTags,
  TokenVendingMachine,
} from '../../src/shared/tvm';
import type { VerifiedClaims } from '../../src/shared/verifier';

/** P-8, ADR-0012: tags from validated claims, one AssumeRole per tag set per lifetime, no values in logs. */
const ROLE_ARN = 'arn:aws:iam::111122223333:role/runtime-isolation-tenant';
const config = (overrides: Partial<TvmConfig> = {}): TvmConfig => ({
  roleArn: ROLE_ARN,
  includeUserIdTag: false,
  claimTags: {},
  durationSeconds: 900,
  ...overrides,
});
const claims = (overrides: Partial<VerifiedClaims> & { extra?: Record<string, unknown> } = {}): VerifiedClaims => ({
  tenantId: 'tenant-a',
  sub: 'user-a1',
  clientId: 'client',
  scopes: ['tenant-api/read'],
  claims: { tenant_id: 'tenant-a', sub: 'user-a1', ...(overrides.extra ?? {}) },
  ...overrides,
});

describe('sessionTags', () => {
  it('always sets TenantId from the verified tenant_id', () => {
    expect(sessionTags(claims(), config())).toEqual([{ Key: 'TenantId', Value: 'tenant-a' }]);
  });

  it('adds UserId = sub only on opt-in', () => {
    expect(sessionTags(claims(), config({ includeUserIdTag: true }))).toEqual([
      { Key: 'TenantId', Value: 'tenant-a' },
      { Key: 'UserId', Value: 'user-a1' },
    ]);
  });

  it('adds claimTags from the token, sorted by key', () => {
    const tags = sessionTags(claims({ extra: { 'custom:tier': 'premium', 'region': 'eu' } }), config({ claimTags: { Tier: 'custom:tier', Region: 'region' } }));
    expect(tags).toEqual([
      { Key: 'Region', Value: 'eu' },
      { Key: 'TenantId', Value: 'tenant-a' },
      { Key: 'Tier', Value: 'premium' },
    ]);
  });

  it('a listed claim missing from the token is a ClaimMissingError (the request fails 403)', () => {
    expect(() => sessionTags(claims(), config({ claimTags: { Tier: 'custom:tier' } }))).toThrow(ClaimMissingError);
    expect(() => sessionTags(claims({ extra: { 'custom:tier': 42 } }), config({ claimTags: { Tier: 'custom:tier' } }))).toThrow(ClaimMissingError);
  });

  it('refuses the reserved keys', () => {
    expect(() => sessionTags(claims(), config({ claimTags: { TenantId: 'other' } }))).toThrow(/reserved/);
    expect(() => sessionTags(claims(), config({ claimTags: { UserId: 'sub' } }))).toThrow(/reserved/);
  });
});

describe('roleSessionName', () => {
  it('is tenant-<tenant_id>, sanitised to the STS alphabet and capped at 64', () => {
    expect(roleSessionName('tenant-a')).toBe('tenant-tenant-a');
    expect(roleSessionName('has space/slash')).toBe('tenant-has_space_slash');
    expect(roleSessionName('x'.repeat(100))).toHaveLength(64);
  });
});

describe('TokenVendingMachine', () => {
  const sts = mockClient(STSClient);
  const T0 = 1_700_000_000_000;
  const expiration = (ms: number) => new Date(T0 + ms);

  beforeEach(() => {
    sts.reset();
    sts.on(AssumeRoleCommand).callsFake(async (input) => ({
      Credentials: {
        AccessKeyId: `ASIA-SYNTHETIC-${input.Tags?.find((t: any) => t.Key === 'TenantId')?.Value}`,
        SecretAccessKey: 'synthetic-secret',
        SessionToken: 'synthetic-session-token',
        Expiration: expiration(900_000),
      },
    }));
  });

  const tvm = (cfg: Partial<TvmConfig> = {}, now: () => number = () => T0, random: () => number = () => 0) =>
    new TokenVendingMachine(config(cfg), { sts: new STSClient({}), now, random });

  it('assumes the role with TagSession tags, the session name and the duration from the config', async () => {
    const result = await tvm({ durationSeconds: 1800, includeUserIdTag: true }).vend(claims());
    expect(result.cached).toBe(false);
    expect(result.credentials).toEqual({
      accessKeyId: 'ASIA-SYNTHETIC-tenant-a',
      secretAccessKey: 'synthetic-secret',
      sessionToken: 'synthetic-session-token',
      expiration: expiration(900_000).toISOString(),
    });
    expect(sts).toHaveReceivedCommandWith(AssumeRoleCommand, {
      RoleArn: ROLE_ARN,
      RoleSessionName: 'tenant-tenant-a',
      DurationSeconds: 1800,
      Tags: [
        { Key: 'TenantId', Value: 'tenant-a' },
        { Key: 'UserId', Value: 'user-a1' },
      ],
    });
  });

  it('caches per tag set: a second call for the same tenant makes no STS call, another tenant does', async () => {
    const machine = tvm();
    await machine.vend(claims());
    const again = await machine.vend(claims({ sub: 'user-a2', claims: { sub: 'user-a2', tenant_id: 'tenant-a' } }));
    expect(again.cached).toBe(true);
    expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 1);
    const other = await machine.vend(claims({ tenantId: 'tenant-b' }));
    expect(other.cached).toBe(false);
    expect(other.credentials.accessKeyId).toBe('ASIA-SYNTHETIC-tenant-b');
    expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
    expect(machine.size).toBe(2);
  });

  it('with UserId on, two users of one tenant are two tag sets', async () => {
    const machine = tvm({ includeUserIdTag: true });
    await machine.vend(claims());
    await machine.vend(claims({ sub: 'user-a2' }));
    expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
  });

  it('refreshes two minutes before expiry (plus jitter), not before', async () => {
    let now = T0;
    const machine = tvm({}, () => now, () => 0);
    await machine.vend(claims());
    // 900 s lifetime; well before the margin and the refresh-ahead window the entry is simply fresh.
    now = T0 + 900_000 - REFRESH_MARGIN_MS - REFRESH_AHEAD_MS - 1000;
    expect((await machine.vend(claims())).cached).toBe(true);
    expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 1);
    // At exactly the margin, with no request in the ahead window, it is refreshed on the request path.
    now = T0 + 900_000 - REFRESH_MARGIN_MS;
    expect((await machine.vend(claims())).cached).toBe(false);
    expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
  });

  describe('refresh-ahead (ADR-0023)', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let clock: number;
    beforeEach(() => {
      clock = T0;
      // Credentials expire 900 s after the call that vended them.
      sts.on(AssumeRoleCommand).callsFake(async () => ({
        Credentials: { AccessKeyId: `ASIA-SYNTHETIC-${clock}`, SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(clock + 900_000) },
      }));
    });

    it('within REFRESH_AHEAD_MS of the margin a hit is served and one AssumeRole runs in the background', async () => {
      const machine = tvm({}, () => clock, () => 0);
      const first = await machine.vend(claims());
      clock = T0 + 900_000 - REFRESH_MARGIN_MS - REFRESH_AHEAD_MS + 1000;
      const served = await machine.vend(claims());
      expect(served.cached).toBe(true);
      expect(served.credentials).toEqual(first.credentials);
      await flush();
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
      // Past the old margin the refreshed entry is a plain hit: no wait, no third call.
      clock = T0 + 900_000 - REFRESH_MARGIN_MS + 1000;
      const later = await machine.vend(claims());
      expect(later.cached).toBe(true);
      expect(later.credentials).not.toEqual(first.credentials);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
    });

    it('many hits in the ahead window start one refresh, not one each', async () => {
      const machine = tvm({}, () => clock, () => 0);
      await machine.vend(claims());
      clock = T0 + 900_000 - REFRESH_MARGIN_MS - 1000;
      await Promise.all([machine.vend(claims()), machine.vend(claims()), machine.vend(claims())]);
      await flush();
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
    });

    it('a failed background refresh keeps the entry; the request path retries at the margin', async () => {
      const ok = async () => ({
        Credentials: { AccessKeyId: `ASIA-SYNTHETIC-${clock}`, SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(clock + 900_000) },
      });
      // First call vends, the second (the background refresh) is throttled, the third succeeds.
      sts.on(AssumeRoleCommand).callsFakeOnce(ok).rejectsOnce(new Error('Throttling')).callsFake(ok);
      const machine = tvm({}, () => clock, () => 0);
      const first = await machine.vend(claims());
      clock = T0 + 900_000 - REFRESH_MARGIN_MS - 1000;
      expect((await machine.vend(claims())).credentials).toEqual(first.credentials);
      await flush();
      expect(machine.size).toBe(1);
      clock = T0 + 900_000 - REFRESH_MARGIN_MS;
      const retried = await machine.vend(claims());
      expect(retried.cached).toBe(false);
      expect(retried.credentials).not.toEqual(first.credentials);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 3);
    });
  });

  it('jitter widens the margin by up to REFRESH_JITTER_MS, fixed per entry', async () => {
    let now = T0;
    const machine = tvm({}, () => now, () => 0.999);
    await machine.vend(claims());
    now = T0 + 900_000 - REFRESH_MARGIN_MS - Math.floor(0.999 * REFRESH_JITTER_MS) + 1;
    expect((await machine.vend(claims())).cached).toBe(false);
  });

  it('propagates STS failures (the ingress turns them into 502)', async () => {
    sts.on(AssumeRoleCommand).rejects(new Error('AccessDenied'));
    await expect(tvm().vend(claims())).rejects.toThrow('AccessDenied');
  });

  it('fails when STS returns no credentials', async () => {
    sts.on(AssumeRoleCommand).resolves({});
    await expect(tvm().vend(claims())).rejects.toThrow(/no credentials/);
  });

  it('never logs a tag value or a credential', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await tvm().vend(claims());
      const everything = [...spy.mock.calls, ...out.mock.calls].flat().map(String).join('\n');
      expect(everything).not.toContain('synthetic-secret');
      expect(everything).not.toContain('ASIA-SYNTHETIC');
      expect(everything).not.toContain('tenant-a');
    } finally {
      spy.mockRestore();
      out.mockRestore();
    }
  });
  describe('bounded cache and single flight (ADR-0022)', () => {
    let clock: number;
    const tenant = (id: string) => claims({ tenantId: id });
    beforeEach(() => {
      clock = T0;
      sts.on(AssumeRoleCommand).callsFake(async (input) => ({
        Credentials: {
          AccessKeyId: `ASIA-SYNTHETIC-${input.Tags?.find((t: any) => t.Key === 'TenantId')?.Value}`,
          SecretAccessKey: 'synthetic-secret',
          SessionToken: 'synthetic-session-token',
          Expiration: new Date(clock + 900_000),
        },
      }));
    });
    const bounded = (cacheMaxEntries?: number) => tvm({ cacheMaxEntries }, () => clock);

    it('defaults to DEFAULT_CACHE_MAX_ENTRIES and refuses a non-positive bound', () => {
      expect(DEFAULT_CACHE_MAX_ENTRIES).toBe(1000);
      expect(() => bounded(0)).toThrow(/cacheMaxEntries/);
      expect(() => bounded(1.5)).toThrow(/cacheMaxEntries/);
    });

    it('never holds more than cacheMaxEntries tag sets', async () => {
      const machine = bounded(3);
      for (let i = 0; i < 10; i++) {
        await machine.vend(tenant(`tenant-${i}`));
        expect(machine.size).toBeLessThanOrEqual(3);
      }
      expect(machine.size).toBe(3);
    });

    it('evicts the least recently used; a hit refreshes recency', async () => {
      const machine = bounded(2);
      await machine.vend(tenant('tenant-a'));
      await machine.vend(tenant('tenant-b'));
      expect((await machine.vend(tenant('tenant-a'))).cached).toBe(true);
      await machine.vend(tenant('tenant-c'));
      expect(machine.size).toBe(2);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 3);
      expect((await machine.vend(tenant('tenant-a'))).cached).toBe(true);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 3);
      expect((await machine.vend(tenant('tenant-b'))).cached).toBe(false);
    });

    it('evicts expired entries before fresh ones, even when the expired one was used more recently', async () => {
      const machine = bounded(2);
      await machine.vend(tenant('tenant-a'));
      clock = T0 + 600_000;
      await machine.vend(tenant('tenant-b'));
      // tenant-a has 250 s left: a plain hit, outside the refresh-ahead window (ADR-0023).
      clock = T0 + 650_000;
      expect((await machine.vend(tenant('tenant-a'))).cached).toBe(true);
      // Now tenant-a has 100 s left (inside the margin): it is the one evicted, though used after tenant-b.
      clock = T0 + 800_000;
      await machine.vend(tenant('tenant-c'));
      expect(machine.size).toBe(2);
      expect((await machine.vend(tenant('tenant-b'))).cached).toBe(true);
      expect((await machine.vend(tenant('tenant-c'))).cached).toBe(true);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 3);
    });

    it('two concurrent vend() calls for one tag set make exactly one AssumeRole', async () => {
      const machine = bounded();
      const [a, b] = await Promise.all([machine.vend(tenant('tenant-a')), machine.vend(tenant('tenant-a'))]);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 1);
      expect(a.credentials).toEqual(b.credentials);
      expect([a.cached, b.cached].sort()).toEqual([false, true]);
      expect(machine.size).toBe(1);
    });

    it('a failed in-flight call is shared, not cached, and the next call retries', async () => {
      sts.on(AssumeRoleCommand).rejectsOnce(new Error('Throttling')).callsFake(async () => ({
        Credentials: { AccessKeyId: 'ASIA-SYNTHETIC-retry', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(clock + 900_000) },
      }));
      const machine = bounded();
      const results = await Promise.allSettled([machine.vend(tenant('tenant-a')), machine.vend(tenant('tenant-a'))]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 1);
      expect(machine.size).toBe(0);
      const retry = await machine.vend(tenant('tenant-a'));
      expect(retry.cached).toBe(false);
      expect(retry.credentials.accessKeyId).toBe('ASIA-SYNTHETIC-retry');
      expect(sts).toHaveReceivedCommandTimes(AssumeRoleCommand, 2);
    });
  });
});
