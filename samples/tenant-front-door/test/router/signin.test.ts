// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `host` mode sign-in at the edge (spec §3.3 steps 2 and 8, §3.5,
 * ADR-0016): `/signin-state`, `/logout` on a tenant host, and the sign-in
 * host `login.<appDomain>`, against `signin-state.json` and the reference
 * in `test/support/signin-state.ts`.
 */

import {
  ACME_HOST, DEDICATED_HOST, event, header, HOST_DOMAIN, loadRouter, NOW, readFixture, RequestSpec, Router, T_ACME, T_DEDICATED, T_SUSPENDED,
  tokenValues,
} from './harness';
import { SIGNIN_STATE_TTL_SECONDS, SigninStatePayload } from '../../src/shared/contracts';
import { decodeSigninEntry } from '../../src/shared/route-table';
import { mintState, verifyState } from '../support/signin-state';

const LOGIN_HOST = `login.${HOST_DOMAIN}`;
const NONCE = 'AbCdEfGhIjKlMnOp_-0123';
const f = readFixture('signin-state.json');
const signin = decodeSigninEntry(f.signin);

const hostMode = (now: number = NOW): Router => loadRouter(tokenValues({ appDomain: HOST_DOMAIN, addressing: 'host' }), now);
const run = (r: Router, spec: RequestSpec) => r.run(event(spec));
const callback = (r: Router, query: Record<string, string | string[]>) => run(r, { host: LOGIN_HOST, uri: '/callback', query });

describe('step 8: /signin-state (host)', () => {
  test('step 8: mints a state for the host and nonce that the reference verifies, signed with cur, 10 minutes', async () => {
    const r = hostMode();
    const a = await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: NONCE } });
    expect(a.statusCode).toBe(200);
    expect(header(a, 'cache-control')).toBe('no-store');
    expect(header(a, 'content-type')).toBe('application/json');
    const { state } = JSON.parse(a.body!.data);
    const v = verifyState(signin, state, NOW);
    expect(v).toEqual({ ok: true, payload: { v: 1, kid: 'k2', h: ACME_HOST, n: NONCE, exp: NOW + SIGNIN_STATE_TTL_SECONDS } });
    expect(state).toBe(f.valid[0].state);
    expect(r.reads).toEqual([`host#${ACME_HOST}`, `tenant#${T_ACME}`, 'signin']);
  });

  test('step 8: after rotation the new cur signs', async () => {
    const r = hostMode();
    r.store.set('signin', f.signin.replace('"cur":"k2"', '"cur":"k1"'));
    const { state } = JSON.parse((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: NONCE } })).body!.data);
    expect(state).toBe(mintState(signin, { v: 1, kid: 'k1', h: ACME_HOST, n: NONCE, exp: NOW + 600 }));
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['15 characters', 'A'.repeat(15)],
    ['65 characters', 'A'.repeat(65)],
    ['a character outside base64url', `${'A'.repeat(16)}=`],
    ['repeated', [NONCE, NONCE]],
  ] as const)('step 8: a nonce that is %s gets 400', async (_n, nonce) => {
    const query: Record<string, string | string[]> = nonce === undefined ? {} : { nonce: nonce as string | string[] };
    const a = await run(hostMode(), { host: ACME_HOST, uri: '/signin-state', query });
    expect(a.statusCode).toBe(400);
  });

  test('step 8: 16 and 64 characters are accepted', async () => {
    for (const nonce of ['A'.repeat(16), 'z'.repeat(64)]) {
      expect((await run(hostMode(), { host: ACME_HOST, uri: '/signin-state', query: { nonce } })).statusCode).toBe(200);
    }
  });

  test('step 8: a dedicated domain mints no state: 400', async () => {
    expect((await run(hostMode(), { host: DEDICATED_HOST, uri: '/signin-state', query: { nonce: NONCE } })).statusCode).toBe(400);
  });

  test('step 5: an unknown host gets 404 and mints nothing', async () => {
    const r = hostMode();
    expect((await run(r, { host: `nobody.${HOST_DOMAIN}`, uri: '/signin-state', query: { nonce: NONCE } })).statusCode).toBe(404);
    expect(r.reads).not.toContain('signin');
  });

  test('step 2 and 8: a reserved label is no pooled host, even with a host# entry: no state is minted for it', async () => {
    const r = hostMode();
    const www = `www.${HOST_DOMAIN}`;
    r.store.set(`host#${www}`, `{"v":1,"t":"${T_ACME}","ac":"111111111111"}`);
    expect((await run(r, { host: www, uri: '/signin-state', query: { nonce: NONCE } })).statusCode).toBe(400);
    expect((await run(r, { host: www, uri: '/logout' })).statusCode).toBe(400);
    const st = mintState(signin, { v: 1, kid: 'k2', h: www, n: NONCE, exp: NOW + 600 });
    expect((await callback(r, { state: st, code: 'abc' })).statusCode).toBe(400);
  });

  test('step 8: no signin key gets 503', async () => {
    const r = hostMode();
    r.store.delete('signin');
    expect((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: NONCE } })).statusCode).toBe(503);
  });
});

describe('step 8: /logout on a tenant host (host, §3.5 step 5)', () => {
  test('step 8: 302 to the issuer logout in the redirect_uri form with a state for the host and no n', async () => {
    const r = hostMode();
    const a = await run(r, { host: ACME_HOST, uri: '/logout' });
    expect(a.statusCode).toBe(302);
    expect(header(a, 'clear-site-data')).toBe('"storage", "cache"');
    expect(header(a, 'cache-control')).toBe('no-store');
    const url = new URL(header(a, 'location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.example.com/logout');
    expect([...url.searchParams.keys()]).toEqual(['client_id', 'response_type', 'scope', 'redirect_uri', 'state']);
    expect(url.searchParams.get('client_id')).toBe('exampleclientid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('redirect_uri')).toBe(`https://${LOGIN_HOST}/callback`);
    const state = url.searchParams.get('state')!;
    expect(state).toBe(f.valid[1].state);
    expect(verifyState(signin, state, NOW)).toEqual({ ok: true, payload: { v: 1, kid: 'k2', h: ACME_HOST, exp: NOW + 600 } });
    expect(r.reads.length).toBeLessThanOrEqual(3);
  });
});

describe('step 2: the sign-in host login.<appDomain> (host)', () => {
  test.each(f.valid.filter((c: any) => c.payload.n !== undefined).map((c: any) => [c.name, c]) as [string, any][])(
    'step 2: valid state (%s) with a code: 302 to https://<h>/callback with the same state and code', async (_n, c) => {
      const r = hostMode();
      const a = await callback(r, { state: c.state, code: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d' });
      expect(a.statusCode).toBe(302);
      expect(header(a, 'cache-control')).toBe('no-store');
      expect(header(a, 'location')).toBe(`https://${ACME_HOST}/callback?state=${c.state}&code=a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d`);
      expect(r.reads).toEqual(['signin', `host#${ACME_HOST}`, `tenant#${T_ACME}`]);
      expect(r.logs).toEqual([]);
    });

  test('step 2: the logout state (no n) with a code: 302 to https://<h>/ without the code', async () => {
    const a = await callback(hostMode(), { state: f.valid[1].state, code: 'abc' });
    expect(header(a, 'location')).toBe(`https://${ACME_HOST}/`);
  });

  test('step 2: a valid state with error: error and error_description are forwarded, encoded once', async () => {
    const a = await callback(hostMode(), { state: f.valid[0].state, error: 'access_denied', error_description: 'User%20cancelled+login' });
    expect(header(a, 'location')).toBe(
      `https://${ACME_HOST}/callback?state=${f.valid[0].state}&error=access_denied&error_description=User%20cancelled+login`);
  });

  test('step 2: existing escapes are kept when other characters in the value are encoded', async () => {
    const a = await callback(hostMode(), { state: f.valid[0].state, error: 'invalid_scope', error_description: 'a%20b:c/d' });
    expect(header(a, 'location')).toContain('&error_description=a%20b%3Ac%2Fd');
    expect(new URL(header(a, 'location')!).searchParams.get('error_description')).toBe('a b:c/d');
  });

  test('step 2: a value with characters that need encoding is encoded, so it cannot add a parameter', async () => {
    const a = await callback(hostMode(), { state: f.valid[0].state, error: 'x&code=evil', error_description: 'a b#c' });
    const url = new URL(header(a, 'location')!);
    expect(url.searchParams.get('code')).toBeNull();
    expect(url.searchParams.get('error')).toBe('x&code=evil');
    expect(url.searchParams.get('error_description')).toBe('a b#c');
    expect(url.hash).toBe('');
  });

  test.each(f.invalid.filter((c: any) => c.why !== 'expired').map((c: any) => [c.name, c]) as [string, any][])(
    'step 2: invalid state (%s) gets 400 with a static body', async (_n, c) => {
      const a = await callback(hostMode(), { state: c.state, code: 'abc' });
      expect(a.statusCode).toBe(400);
      expect(a.body).toEqual({ encoding: 'text', data: '{"status":400}' });
      expect(header(a, 'location')).toBeUndefined();
    });

  test('step 2: an authentic expired state (exp equals now) gets 302 to https://<h>/ without the code', async () => {
    const expired = f.invalid.find((c: any) => c.why === 'expired');
    const a = await callback(hostMode(), { state: expired.state, code: 'abc' });
    expect(a.statusCode).toBe(302);
    expect(header(a, 'location')).toBe(`https://${ACME_HOST}/`);
  });

  test('step 2: a valid state one second before exp still forwards; at exp it does not', async () => {
    expect(header(await callback(hostMode(NOW + 599), { state: f.valid[0].state, code: 'c' }), 'location')).toContain('/callback?');
    expect(header(await callback(hostMode(NOW + 600), { state: f.valid[0].state, code: 'c' }), 'location')).toBe(`https://${ACME_HOST}/`);
  });

  const signed = (payload: SigninStatePayload) => mintState(signin, payload);

  test.each([
    ['h a dedicated domain', { v: 1, kid: 'k2', h: DEDICATED_HOST, n: NONCE, exp: NOW + 600 }],
    ['h outside appDomain', { v: 1, kid: 'k2', h: 'evil.example.net', n: NONCE, exp: NOW + 600 }],
    ['h two labels under appDomain', { v: 1, kid: 'k2', h: `a.${ACME_HOST}`, n: NONCE, exp: NOW + 600 }],
    ['h a reserved label', { v: 1, kid: 'k2', h: `www.${HOST_DOMAIN}`, n: NONCE, exp: NOW + 600 }],
    ['h the sign-in host', { v: 1, kid: 'k2', h: LOGIN_HOST, n: NONCE, exp: NOW + 600 }],
    ['h an unregistered pooled host', { v: 1, kid: 'k2', h: `nobody.${HOST_DOMAIN}`, n: NONCE, exp: NOW + 600 }],
    ['h a suspended tenant', { v: 1, kid: 'k2', h: `${T_SUSPENDED}.${HOST_DOMAIN}`, n: NONCE, exp: NOW + 600 }],
    ['h a host with no tenant entry', { v: 1, kid: 'k2', h: `left.${HOST_DOMAIN}`, n: NONCE, exp: NOW + 600 }],
    ['an expired state for a suspended tenant', { v: 1, kid: 'k2', h: `${T_SUSPENDED}.${HOST_DOMAIN}`, n: NONCE, exp: NOW }],
    ['v not 1', { v: 2, kid: 'k2', h: ACME_HOST, n: NONCE, exp: NOW + 600 }],
    ['exp not a number', { v: 1, kid: 'k2', h: ACME_HOST, n: NONCE, exp: String(NOW + 600) }],
    ['kid __proto__', { v: 1, kid: '__proto__', h: ACME_HOST, n: NONCE, exp: NOW + 600 }],
  ] as [string, any][])('step 2: a correctly signed state with %s gets 400', async (_n, payload) => {
    const r = hostMode();
    r.store.set(`host#${T_SUSPENDED}.${HOST_DOMAIN}`, `{"v":1,"t":"${T_SUSPENDED}","ac":"111111111111"}`);
    r.store.set(`host#left.${HOST_DOMAIN}`, '{"v":1,"t":"left","ac":"111111111111"}');
    let state: string;
    try {
      state = signed(payload);
    } catch {
      // `__proto__` names no key in the reference; sign with k2 under that kid by hand.
      const enc = Buffer.from(JSON.stringify(payload)).toString('base64url');
      state = `${enc}.${signed({ v: 1, kid: 'k2', h: ACME_HOST, exp: 0 }).split('.')[1]}`;
    }
    expect((await callback(r, { state, code: 'abc' })).statusCode).toBe(400);
  });

  test.each([
    ['no state', { code: 'abc' }],
    ['no code and no error', { state: f.valid[0].state }],
    ['both code and error', { state: f.valid[0].state, code: 'abc', error: 'access_denied' }],
    ['an empty code', { state: f.valid[0].state, code: '' }],
    ['a repeated state', { state: [f.valid[0].state, f.valid[2].state], code: 'abc' }],
    ['a repeated code', { state: f.valid[0].state, code: ['abc', 'def'] }],
  ] as [string, Record<string, string | string[]>][])('step 2: /callback with %s gets 400', async (_n, query) => {
    expect((await callback(hostMode(), query)).statusCode).toBe(400);
  });

  test('step 2: no signin key gets 400', async () => {
    const r = hostMode();
    r.store.delete('signin');
    expect((await callback(r, { state: f.valid[0].state, code: 'abc' })).statusCode).toBe(400);
  });

  test('step 2: a state for a host whose tenant is not the dedicated one still goes to its own pooled host', async () => {
    const st = mintState(signin, { v: 1, kid: 'k2', h: `${T_DEDICATED}.${HOST_DOMAIN}`, n: NONCE, exp: NOW + 600 });
    const a = await callback(hostMode(), { state: st, code: 'abc' });
    expect(header(a, 'location')).toBe(`https://${T_DEDICATED}.${HOST_DOMAIN}/callback?state=${st}&code=abc`);
  });

  test('step 2: /logout on the sign-in host is a static signed-out page that names no tenant', async () => {
    const r = hostMode();
    const a = await run(r, { host: LOGIN_HOST, uri: '/logout', query: { state: f.valid[1].state } });
    expect(a.statusCode).toBe(200);
    expect(header(a, 'content-type')).toBe('text/html; charset=utf-8');
    expect(header(a, 'cache-control')).toBe('no-store');
    expect(a.body!.data).not.toContain(T_ACME);
    expect(r.reads).toEqual([]);
  });

  test.each(['/', '/index.html', '/config.json', '/signin-state', '/api/items', '/agents/support-bot/invocations', '/callback/'])(
    'step 2: any other path on the sign-in host (%s) gets 400 before any host# lookup', async (uri) => {
      const r = hostMode();
      const a = await run(r, { host: LOGIN_HOST, uri, query: { state: f.valid[0].state, code: 'abc', nonce: NONCE } });
      expect(a.statusCode).toBe(400);
      expect(r.reads).toEqual([]);
    });

  test('§3.5 round trip: a state from /signin-state passes the sign-in host and reaches its own host', async () => {
    const r = hostMode();
    const { state } = JSON.parse((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: NONCE } })).body!.data);
    const a = await callback(r, { state, code: 'abc' });
    expect(header(a, 'location')).toBe(`https://${ACME_HOST}/callback?state=${state}&code=abc`);
  });

  test('§3.5: a state from /signin-state is refused once the key that signed it is dropped', async () => {
    const r = hostMode();
    r.store.set('signin', f.signin.replace('"cur":"k2"', '"cur":"k1"'));
    const { state } = JSON.parse((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: NONCE } })).body!.data);
    r.store.set('signin', '{"v":1,"cur":"k2","k":{"k2":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA="}}');
    expect((await callback(r, { state, code: 'abc' })).statusCode).toBe(400);
  });

  test('step 2 (single): there is no sign-in host and no /signin-state', async () => {
    const r = loadRouter(tokenValues());
    expect((await run(r, { host: 'app.example.com', uri: '/signin-state', query: { nonce: NONCE } })).statusCode).toBe(404);
  });
});
