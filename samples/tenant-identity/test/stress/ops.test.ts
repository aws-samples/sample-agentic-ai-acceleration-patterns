// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyManifest, manifestPath, readManifest, writeManifest } from './manifest';
import {
  assertTokenTenant,
  createTenantWithAdmin,
  type Ctx,
  Pacer,
  probeForeignExchange,
  probeForeignRefresh,
  probeForeignRefreshToken,
  randomPassword,
  runPool,
  withRetry,
} from './ops';
import { Recorder } from './recorder';
import type { HttpResult } from '../e2e/clients';

const result = (status: number, body: unknown = {}): HttpResult<any> => ({ status, body });

function ctxWith(parts: Partial<Record<'platform' | 'exchange' | 'verifier', unknown>>): Ctx {
  return { clientId: 'client', tenantApi: {}, ...parts } as unknown as Ctx;
}

describe('withRetry', () => {
  test('retries a throttle and stops at the first answer', async () => {
    const answers = [result(429), result(503), result(201)];
    const call = jest.fn(async () => answers.shift()!);
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout);
    const r = await withRetry(call);
    jest.restoreAllMocks();
    expect(r.status).toBe(201);
    expect(call).toHaveBeenCalledTimes(3);
  });

  test('does not retry a refusal', async () => {
    const call = jest.fn(async () => result(404));
    expect((await withRetry(call)).status).toBe(404);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('runPool and Pacer', () => {
  test('runs every item with at most `limit` at once', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      seen.push(n);
      active -= 1;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  test('a pacer spaces callers', async () => {
    const pacer = new Pacer(100);
    const t0 = Date.now();
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
});

describe('randomPassword', () => {
  test('meets the pool policy and differs every call', () => {
    const a = randomPassword();
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(randomPassword()).not.toBe(a);
  });
});

describe('isolation assertions (P-1)', () => {
  const verifier = (claims: Record<string, unknown> | Error) => ({
    verify: async () => {
      if (claims instanceof Error) throw claims;
      return claims;
    },
  });

  test('a token that names its tenant holds', async () => {
    const rec = new Recorder();
    await assertTokenTenant(ctxWith({ verifier: verifier({ tenant_id: 'A', scope: 'x tenant-admin/users' }) }), rec, 't', 'A', 'x', 'tenant-admin/users');
    expect(rec.totals).toMatchObject({ mismatches: 0 });
    expect(rec.totals.assertions).toBeGreaterThanOrEqual(3);
  });

  test('a token for tenant A presented as tenant B is a mismatch', async () => {
    const rec = new Recorder();
    await assertTokenTenant(ctxWith({ verifier: verifier({ tenant_id: 'A' }) }), rec, 't', 'B', 'x');
    expect(rec.totals.mismatches).toBe(1);
  });

  test('a groups or tenants claim, and a token that does not verify, are mismatches', async () => {
    const rec = new Recorder();
    await assertTokenTenant(ctxWith({ verifier: verifier({ 'tenant_id': 'A', 'cognito:groups': ['t-A'] }) }), rec, 't', 'A', 'x');
    await assertTokenTenant(ctxWith({ verifier: verifier(new Error('bad')) }), rec, 't', 'A', 'x');
    expect(rec.totals.mismatches).toBe(2);
  });

  test.each([404, 400])('a foreign path or exchange answered %d holds', async (status) => {
    const rec = new Recorder();
    const ctx = ctxWith({ platform: { call: async () => result(status) }, exchange: { exchange: async () => result(status) } });
    await probeForeignRefresh(ctx, rec, 'A', 'B', 'u', 'r');
    await probeForeignExchange(ctx, rec, 'A', 'B', 'r');
    expect(rec.totals).toMatchObject({ assertions: 2, mismatches: 0 });
  });

  test('a foreign path or exchange that is served is a mismatch', async () => {
    const rec = new Recorder();
    const ctx = ctxWith({ platform: { call: async () => result(200, { accessToken: 'x' }) }, exchange: { exchange: async () => result(200, { access_token: 'x' }) } });
    await probeForeignRefresh(ctx, rec, 'A', 'B', 'u', 'r');
    await probeForeignExchange(ctx, rec, 'A', 'B', 'r');
    expect(rec.totals.mismatches).toBe(2);
  });

  test('a server error makes no assertion and is a finding', async () => {
    const rec = new Recorder();
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout);
    await probeForeignRefresh(ctxWith({ platform: { call: async () => result(500) } }), rec, 'A', 'B', 'u', 'r');
    jest.restoreAllMocks();
    expect(rec.totals.assertions).toBe(0);
    expect(rec.findings.length).toBeGreaterThan(0);
  });
});

describe('manifest', () => {
  test('is written 0600 in a 0700 folder, and holds no token or password field', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-stress-'));
    const file = manifestPath(home, 'stress-x');
    const m = { ...emptyManifest('stress-x', 'stress-x-identity', 'small', 'a'.repeat(40)), transient: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] };
    writeManifest(file, m);
    expect((fs.statSync(file).mode % 0o1000).toString(8)).toBe('600');
    expect((fs.statSync(path.dirname(file)).mode % 0o1000).toString(8)).toBe('700');
    expect(readManifest(file)).toEqual(m);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/token|password|secret/i);
    expect(readManifest(path.join(home, 'none.json'))).toBeUndefined();
  });
});

/** Runs `fn` with every backoff sleep made instant. */
async function instant<T>(fn: () => Promise<T>): Promise<T> {
  jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => { cb(); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout);
  try {
    return await fn();
  } finally {
    jest.restoreAllMocks();
  }
}

/** A platform client that answers each `METHOD path` from a queue of results. */
function scripted(routes: Record<string, HttpResult<any>[]>) {
  const calls: { key: string; body: unknown }[] = [];
  return {
    calls,
    call: async (method: string, p: string, body?: unknown) => {
      const key = `${method} ${p.replace(/\?.*$/, '')}`;
      calls.push({ key, body });
      const queue = routes[key];
      if (queue === undefined || queue.length === 0) throw new Error(`unexpected ${key}`);
      return queue.length === 1 ? queue[0] : queue.shift()!;
    },
  };
}

describe('createTenantWithAdmin (ADR-0037 recovery)', () => {
  const spec = { tenantId: 'T', name: 'p-s-0000', adminEmail: 'a@x' };

  test('a 503 that left the tenant ACTIVE claims the first-admin slot instead of creating again', async () => {
    const platform = scripted({
      'POST platform/tenants': [result(503)],
      'GET platform/tenants/T': [result(200, { tenant: { status: 'ACTIVE' } })],
      'POST platform/tenants/T/users': [result(201, { user: { username: 'admin-1' } })],
    });
    const rec = new Recorder();
    expect(await instant(() => createTenantWithAdmin(ctxWith({ platform }), rec, spec))).toBe('admin-1');
    expect(platform.calls.filter((c) => c.key === 'POST platform/tenants')).toHaveLength(1);
    expect(platform.calls.find((c) => c.key === 'POST platform/tenants/T/users')?.body).toEqual({ email: 'a@x', firstAdmin: true });
    expect(rec.findings).toEqual([]);
  });

  test('a 409 whose admin already exists finds the admin by e-mail', async () => {
    const platform = scripted({
      'POST platform/tenants': [result(409)],
      'GET platform/tenants/T': [result(200, { tenant: { status: 'ACTIVE' } })],
      'POST platform/tenants/T/users': [result(409)],
      'GET platform/tenants/T/users': [result(200, { users: [{ username: 'other', email: 'b@x' }, { username: 'admin-1', email: 'a@x' }] })],
    });
    expect(await instant(() => createTenantWithAdmin(ctxWith({ platform }), new Recorder(), spec))).toBe('admin-1');
  });

  test('nothing written (404) and a throttle are retried until the create lands', async () => {
    const platform = scripted({
      'POST platform/tenants': [result(0), result(429), result(201, { admin: { user: { username: 'admin-2' } } })],
      'GET platform/tenants/T': [result(404)],
    });
    expect(await instant(() => createTenantWithAdmin(ctxWith({ platform }), new Recorder(), spec))).toBe('admin-2');
    expect(platform.calls.filter((c) => c.key === 'POST platform/tenants')).toHaveLength(3);
  });

  test('a refusal is a finding and no admin', async () => {
    const platform = scripted({ 'POST platform/tenants': [result(400)] });
    const rec = new Recorder();
    expect(await createTenantWithAdmin(ctxWith({ platform }), rec, spec)).toBeUndefined();
    expect(rec.findings).toHaveLength(1);
  });

  test('a tenant that never becomes ACTIVE gives up after 12 attempts', async () => {
    const platform = scripted({
      'POST platform/tenants': [result(503)],
      'GET platform/tenants/T': [result(200, { tenant: { status: 'PROVISIONING' } })],
    });
    const rec = new Recorder();
    expect(await instant(() => createTenantWithAdmin(ctxWith({ platform }), rec, spec))).toBeUndefined();
    expect(platform.calls.filter((c) => c.key === 'POST platform/tenants')).toHaveLength(12);
    expect(rec.findings.join()).toMatch(/not ACTIVE after 12 attempts/);
  });
});

describe('foreign refresh token on its own path (P-1)', () => {
  const verifier = (tenantId: string) => ({ verify: async () => ({ tenant_id: tenantId }) });

  test('a refusal holds', async () => {
    const rec = new Recorder();
    await probeForeignRefreshToken(ctxWith({ platform: { call: async () => result(400) } }), rec, 'A', 'B', 'b-admin', 'r');
    expect(rec.totals).toMatchObject({ assertions: 1, mismatches: 0 });
    expect(rec.notes.size).toBe(0);
  });

  test("a served answer that names the caller's tenant holds and is noted", async () => {
    const rec = new Recorder();
    const calls: string[] = [];
    const platform = { call: async (_m: string, p: string) => { calls.push(p); return result(200, { accessToken: 'x' }); } };
    await probeForeignRefreshToken(ctxWith({ platform, verifier: verifier('A') }), rec, 'A', 'B', 'b-admin', 'r');
    expect(calls).toEqual(['platform/tenants/B/users/b-admin/token/refresh']);
    expect(rec.totals.mismatches).toBe(0);
    expect(rec.totals.assertions).toBeGreaterThan(0);
    expect([...rec.notes.values()]).toEqual([1]);
  });

  test("a served answer that names the path's tenant is a mismatch", async () => {
    const rec = new Recorder();
    await probeForeignRefreshToken(ctxWith({ platform: { call: async () => result(200, { accessToken: 'x' }) }, verifier: verifier('B') }), rec, 'A', 'B', 'b-admin', 'r');
    expect(rec.totals.mismatches).toBe(1);
  });

  test('a served answer without a token is a finding', async () => {
    const rec = new Recorder();
    await probeForeignRefreshToken(ctxWith({ platform: { call: async () => result(200, {}) } }), rec, 'A', 'B', 'b-admin', 'r');
    expect(rec.findings).toHaveLength(1);
  });
});
