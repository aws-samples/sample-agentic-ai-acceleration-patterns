// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The sign-in flow and the token exchange (spec §3.5, §7.2; tenant-identity §5.4, §5.4.1), with fake browser effects. */

import { b64url, configCase, Call, fakeFetch, formOf, json, jwt, memoryStorage } from './support';
import { EXCHANGE_RETRY_DELAYS_MS, exchangeScope, narrowToken } from '../../spa/src/exchange';
import { beginSignIn, completeSignIn, Env, LOGOUT_PATH, settleTenant, signOut } from '../../spa/src/flow';
import type { FetchLike, ResponseLike } from '../../spa/src/http';
import { PENDING_KEY } from '../../spa/src/signin';

const HOST_TENANT = '01HZX8K9P0QRST7VWXYZ1A2B3C';
const OTHER = '01HZX8K9P0QRST7VWXYZ1A2B3E';
const single = configCase('single, appDomain');
const pooled = configCase('host, pooled tenant host');

function envFor(host: string, fetchFn: FetchLike): Env & { navigated: string[]; slept: number[]; storage: ReturnType<typeof memoryStorage> } {
  const navigated: string[] = [];
  const slept: number[] = [];
  return {
    fetch: fetchFn,
    storage: memoryStorage(),
    sleep: async (ms) => void slept.push(ms),
    navigate: (u) => void navigated.push(u),
    here: { host, origin: `https://${host}` },
    navigated,
    slept,
  };
}

/** A router `state` as `/signin-state` would mint it, with the given nonce (the SPA does not check the MAC). */
function routerState(host: string, n: string | undefined): string {
  return `${b64url(JSON.stringify({ v: 1, kid: 'k2', h: host, n, exp: 1795080600 }))}.bWFj`;
}

describe('beginSignIn (§3.5 steps 1 and 2)', () => {
  test('host, pooled tenant host: asks /signin-state with the nonce, then authorizes with its state and the sign-in host', async () => {
    const f = fakeFetch((url) => json(200, { state: routerState(pooled.host, new URL(url, 'https://x').searchParams.get('nonce')!) }));
    const env = envFor(pooled.host, f);
    await beginSignIn(env, pooled.body);
    const nonce = new URL(f.calls[0].url, 'https://x').searchParams.get('nonce')!;
    expect(f.calls[0]).toEqual({ url: `/signin-state?nonce=${nonce}`, init: { method: 'GET', credentials: 'same-origin' } });
    const saved = JSON.parse(env.storage.map.get(PENDING_KEY)!);
    expect(saved.nonce).toBe(nonce);
    const u = new URL(env.navigated[0]);
    expect(u.searchParams.get('redirect_uri')).toBe('https://login.tenants.example.com/callback');
    expect(u.searchParams.get('state')).toBe(routerState(pooled.host, nonce));
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('single, appDomain: the state is the nonce and redirect_uri is https://<appDomain>/', async () => {
    const f = fakeFetch(() => json(500, {}));
    const env = envFor(single.host, f);
    await beginSignIn(env, single.body);
    expect(f.calls).toHaveLength(0);
    const u = new URL(env.navigated[0]);
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/');
    expect(u.searchParams.get('state')).toBe(JSON.parse(env.storage.map.get(PENDING_KEY)!).nonce);
  });

  test.each([
    ['single, dedicated domain', 'https://app.example.com/'],
    ['host, dedicated domain', 'https://01hzx8k9p0qrst7vwxyz1a2b3e.tenants.example.com/'],
  ])('%s: goes to signInHost and starts no flow there (§3.5)', async (name, url) => {
    const c = configCase(name);
    const f = fakeFetch(() => json(500, {}));
    const env = envFor(c.host, f);
    await beginSignIn(env, c.body);
    expect(env.navigated).toEqual([url]);
    expect(f.calls).toHaveLength(0);
    expect(env.storage.map.size).toBe(0);
  });

  test('host mode: a failed /signin-state saves nothing and does not navigate', async () => {
    const env = envFor(pooled.host, fakeFetch(() => json(404, {})));
    await expect(beginSignIn(env, pooled.body)).rejects.toThrow();
    expect(env.navigated).toHaveLength(0);
    expect(env.storage.map.size).toBe(0);
  });
});

/** Answers the token endpoint with `tokens` and the exchange with `exchange`. */
function issuer(tokens: Record<string, unknown>, exchange?: (call: Call) => ResponseLike | Promise<ResponseLike>): ReturnType<typeof fakeFetch> {
  const f = fakeFetch((url, init) => {
    const form = formOf(init);
    if (form.grant_type === 'authorization_code') return json(200, tokens);
    if (exchange !== undefined) return exchange({ url, init });
    return json(500, {});
  });
  return f;
}

async function signedInVia(cfg: ReturnType<typeof configCase>, f: ReturnType<typeof fakeFetch>, nonce = 'AbCdEfGhIjKlMnOp_-0123') {
  const env = envFor(cfg.host, f);
  env.storage.setItem(PENDING_KEY, JSON.stringify({ v: 1, verifier: 'ver', nonce }));
  const state = cfg.addressing === 'host' ? routerState(cfg.host, nonce) : nonce;
  return { env, outcome: await completeSignIn(env, cfg.body, 'the-code', state) };
}

describe('completeSignIn (§3.5 step 4)', () => {
  test('host, pooled: a token for the host tenant signs in; the saved values are gone', async () => {
    const f = issuer({ access_token: jwt({ tenant_id: HOST_TENANT.toLowerCase() }), refresh_token: 'r' });
    const { env, outcome } = await signedInVia(pooled, f);
    expect(outcome).toMatchObject({ kind: 'signed-in', session: { tenantId: HOST_TENANT.toLowerCase() } });
    expect(formOf(f.calls[0].init)).toMatchObject({ code: 'the-code', code_verifier: 'ver', redirect_uri: 'https://login.tenants.example.com/callback' });
    expect(env.storage.map.size).toBe(0);
  });

  test('host, pooled: a token for another tenant is discarded and the user signed out', async () => {
    const { outcome } = await signedInVia(pooled, issuer({ access_token: jwt({ tenant_id: OTHER }), refresh_token: 'r' }));
    expect(outcome).toEqual({ kind: 'sign-out' });
  });

  test('host, pooled: a tenants token is narrowed to the host tenant through exchangeEndpoint, and the result checked', async () => {
    const f = issuer({ access_token: jwt({ tenants: [OTHER, HOST_TENANT] }), refresh_token: 'refresh-1' },
      () => json(200, { access_token: jwt({ tenant_id: HOST_TENANT }) }));
    const { outcome } = await signedInVia(pooled, f);
    expect(outcome).toMatchObject({ kind: 'signed-in', session: { tenantId: HOST_TENANT, subject: { refreshToken: 'refresh-1' } } });
    expect(f.calls[1].url).toBe('https://api.example.com/prod/oauth2/token');
    expect(formOf(f.calls[1].init)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'exampleclientid',
      subject_token: 'refresh-1',
      subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      resource: `urn:tenant-identity:tenant:${HOST_TENANT}`,
      scope: 'sample/read',
    });
  });

  test('host, pooled: a narrowed token that names another tenant signs out', async () => {
    const f = issuer({ access_token: jwt({ tenants: [HOST_TENANT] }), refresh_token: 'r' }, () => json(200, { access_token: jwt({ tenant_id: OTHER }) }));
    expect((await signedInVia(pooled, f)).outcome).toEqual({ kind: 'sign-out' });
  });

  test('host, pooled: a tenants token that does not list the host tenant signs out with no exchange', async () => {
    const f = issuer({ access_token: jwt({ tenants: [OTHER] }), refresh_token: 'r' });
    expect((await signedInVia(pooled, f)).outcome).toEqual({ kind: 'sign-out' });
    expect(f.calls).toHaveLength(1);
  });

  test('a state whose nonce is not the saved one is refused before the code is redeemed', async () => {
    const f = issuer({ access_token: jwt({ tenant_id: HOST_TENANT }) });
    const env = envFor(pooled.host, f);
    env.storage.setItem(PENDING_KEY, JSON.stringify({ v: 1, verifier: 'ver', nonce: 'AbCdEfGhIjKlMnOp_-0123' }));
    await expect(completeSignIn(env, pooled.body, 'c', routerState(pooled.host, 'ZZZZZZZZZZZZZZZZZZZZZZ'))).resolves.toEqual({ kind: 'failed' });
    expect(f.calls).toHaveLength(0);
    expect(env.storage.map.size).toBe(0);
  });

  test('a callback with nothing saved is refused', async () => {
    const env = envFor(pooled.host, issuer({}));
    await expect(completeSignIn(env, pooled.body, 'c', routerState(pooled.host, 'AbCdEfGhIjKlMnOp_-0123'))).resolves.toEqual({ kind: 'failed' });
  });

  test('single, appDomain: a tenants token asks the user to pick, then narrows to the pick', async () => {
    const f = issuer({ access_token: jwt({ tenants: [HOST_TENANT, OTHER] }), refresh_token: 'r' },
      () => json(200, { access_token: jwt({ tenant_id: OTHER }) }));
    const { env, outcome } = await signedInVia(single, f);
    expect(outcome).toMatchObject({ kind: 'pick-tenant', tenants: [HOST_TENANT, OTHER] });
    if (outcome.kind !== 'pick-tenant') throw new Error('unreachable');
    expect(formOf(f.calls[0].init).redirect_uri).toBe('https://app.example.com/');
    await expect(settleTenant(env, single.body, outcome.subject, OTHER)).resolves.toMatchObject({
      kind: 'signed-in', session: { tenantId: OTHER, tenants: [HOST_TENANT, OTHER] },
    });
  });

  test('single, appDomain: a pick the exchange refuses returns to the picker, with the refresh token kept', async () => {
    const f = issuer({ access_token: jwt({ tenants: [HOST_TENANT, OTHER] }), refresh_token: 'r' },
      () => json(400, { error: 'invalid_target' }));
    const { env, outcome } = await signedInVia(single, f);
    if (outcome.kind !== 'pick-tenant') throw new Error('unreachable');
    await expect(settleTenant(env, single.body, outcome.subject, OTHER)).resolves.toEqual({
      kind: 'pick-tenant', subject: outcome.subject, tenants: [HOST_TENANT, OTHER], refused: true,
    });
    expect(env.navigated).toEqual([]);
  });

  test('host, pooled tenant host: the exchange refusing the host\'s own tenant signs out (§3.5 step 4)', async () => {
    const f = issuer({ access_token: jwt({ tenants: [HOST_TENANT] }), refresh_token: 'r' }, () => json(400, { error: 'invalid_target' }));
    expect((await signedInVia(pooled, f)).outcome).toEqual({ kind: 'sign-out' });
  });

  test('single, appDomain: a single-tenant token signs in to its own tenant', async () => {
    const { outcome } = await signedInVia(single, issuer({ access_token: jwt({ tenant_id: OTHER }) }));
    expect(outcome).toMatchObject({ kind: 'signed-in', session: { tenantId: OTHER } });
  });

  test('a token with no tenant claim signs out', async () => {
    expect((await signedInVia(single, issuer({ access_token: jwt({ sub: 'u' }) }))).outcome).toEqual({ kind: 'sign-out' });
  });
});

describe('token exchange (§7.2, tenant-identity §5.4.1)', () => {
  const cfg = pooled.body;
  const args = { refreshToken: 'r', tenantId: HOST_TENANT.toLowerCase() };

  test('is a CORS simple request: POST, form body, no header set, credentials omitted', async () => {
    const f = fakeFetch(() => json(200, { access_token: 'n' }));
    await narrowToken({ fetch: f, sleep: async () => undefined }, cfg, args);
    const { init } = f.calls[0];
    expect(Object.keys(init).sort()).toEqual(['body', 'credentials', 'method']);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(formOf(init).resource).toBe(`urn:tenant-identity:tenant:${HOST_TENANT}`);
  });

  test('retries a network error twice, after 1 s then 3 s, then gives up and keeps the refresh token', async () => {
    const env = envFor(pooled.host, fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(narrowToken(env, cfg, args)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect((env.fetch as ReturnType<typeof fakeFetch>).calls).toHaveLength(3);
    expect(env.slept).toEqual([1000, 3000]);
    expect(EXCHANGE_RETRY_DELAYS_MS).toEqual([1000, 3000]);
  });

  test('retries server_error and succeeds on a later attempt', async () => {
    let n = 0;
    const env = envFor(pooled.host, fakeFetch(() => (++n < 3 ? json(500, { error: 'server_error' }) : json(200, { access_token: 'ok' }))));
    await expect(narrowToken(env, cfg, args)).resolves.toEqual({ ok: true, accessToken: 'ok' });
    expect(env.slept).toEqual([1000, 3000]);
  });

  test('does not retry a 4xx such as invalid_target', async () => {
    const env = envFor(pooled.host, fakeFetch(() => json(400, { error: 'invalid_target' })));
    await expect(narrowToken(env, cfg, args)).resolves.toEqual({ ok: false, reason: 'refused' });
    expect(env.slept).toEqual([]);
  });

  test('sign-in keeps the refresh token when the exchange is unavailable, and a retry can finish it', async () => {
    let up = false;
    const f = issuer({ access_token: jwt({ tenants: [HOST_TENANT] }), refresh_token: 'keep-me' },
      () => (up ? json(200, { access_token: jwt({ tenant_id: HOST_TENANT }) }) : Promise.reject(new TypeError('net'))));
    const { env, outcome } = await signedInVia(pooled, f);
    expect(outcome).toMatchObject({ kind: 'unavailable', subject: { refreshToken: 'keep-me' }, tenantId: HOST_TENANT });
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    up = true;
    await expect(settleTenant(env, pooled.body, outcome.subject, outcome.tenantId)).resolves.toMatchObject({ kind: 'signed-in' });
  });

  test('without exchangeEndpoint the exchange goes to the token endpoint (§3.5)', async () => {
    const { exchangeEndpoint: _drop, ...noExchange } = cfg;
    const f = fakeFetch(() => json(200, { access_token: 'n' }));
    await narrowToken({ fetch: f, sleep: async () => undefined }, noExchange, args);
    expect(f.calls[0].url).toBe(cfg.tokenEndpoint);
  });

  test('scope keeps catalogue scopes only, since the exchange refuses openid (tenant-identity §4.4, §5.4)', async () => {
    expect(exchangeScope('openid sample/read profile sample/read tenant-admin/users aws.cognito.signin.user.admin'))
      .toBe('sample/read tenant-admin/users');
    const f = fakeFetch(() => json(200, { access_token: 'n' }));
    await expect(narrowToken({ fetch: f, sleep: async () => undefined }, { ...cfg, scopes: 'openid' }, args))
      .resolves.toEqual({ ok: false, reason: 'refused' });
    expect(f.calls).toHaveLength(0);
  });
});

test('signOut clears the saved values and leaves through /logout (§3.5 step 5)', () => {
  const env = envFor(pooled.host, fakeFetch(() => json(200, {})));
  env.storage.setItem(PENDING_KEY, 'x');
  signOut(env);
  expect(env.storage.map.size).toBe(0);
  expect(env.navigated).toEqual([LOGOUT_PATH]);
});
