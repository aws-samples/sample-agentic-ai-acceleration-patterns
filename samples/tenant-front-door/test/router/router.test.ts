// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant router, step by step (spec §3.3), with the answers of §4.2
 * and §5.3. Sign-in in `host` mode is in `signin.test.ts`.
 */

import {
  ACME_HOST, CELL_ORIGIN, DEDICATED_HOST, event, header, HOST_DOMAIN, loadRouter, readFixture, RequestSpec, Router,
  SINGLE_DOMAIN, T_ACME, T_DEDICATED, T_NO_HOST, T_SUSPENDED, token, tokenFor, tokenValues,
} from './harness';

const single = (): Router => loadRouter(tokenValues());
const hostMode = (): Router => loadRouter(tokenValues({ appDomain: HOST_DOMAIN, addressing: 'host' }));

/** A host-mode host whose `host#` entry names the suspended tenant, added for these tests only. */
const SUSPENDED_HOST = `${T_SUSPENDED}.${HOST_DOMAIN}`;
function withSuspendedHost(r: Router): Router {
  r.store.set(`host#${SUSPENDED_HOST}`, `{"v":1,"t":"${T_SUSPENDED}","ac":"111111111111"}`);
  return r;
}

const run = (r: Router, spec: RequestSpec) => r.run(event(spec));
const status = (a: { statusCode?: number }) => a.statusCode ?? 'forwarded';

describe('step 1: client x-tenant-* headers', () => {
  test('step 1: every x-tenant-* header is removed from an SPA request', async () => {
    const a = await run(single(), {
      host: SINGLE_DOMAIN, uri: '/', headers: { 'x-tenant-route': T_ACME, 'x-tenant-token': 'forged', 'x-tenant-other': '1', 'x-other': 'kept' },
    });
    expect(Object.keys(a.headers).filter((k) => k.startsWith('x-tenant-'))).toEqual([]);
    expect(header(a, 'x-other')).toBe('kept');
  });

  test('step 1 and 7: on /api/* the client x-tenant-route and x-tenant-token are replaced, not passed on', async () => {
    const a = await run(single(), {
      host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_ACME), headers: { 'x-tenant-route': T_DEDICATED, 'x-tenant-token': 'forged' },
    });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    expect(header(a, 'x-tenant-token')).toBe(tokenFor(T_ACME));
  });
});

describe('step 2: host handling', () => {
  test('step 2: the Host header is lower-cased before it is compared', async () => {
    const r = single();
    const a = await run(r, { host: 'APP.Example.COM', uri: '/config.json' });
    expect(a.statusCode).toBe(200);
    expect(r.reads).toEqual(['app']);
  });

  test('step 2 (host): an unknown host gets 404 and logs no tenant', async () => {
    const r = hostMode();
    const a = await run(r, { host: `unknown.${HOST_DOMAIN}`, uri: '/' });
    expect(a.statusCode).toBe(404);
    expect(header(a, 'cache-control')).toBe('no-store');
    expect(r.logs).toEqual([]);
  });

  test.each([['single', single], ['host', hostMode]] as const)('step 2 (%s): a request with no Host header gets 404', async (_m, make) => {
    const e = event({ host: '', uri: '/' });
    delete e.request.headers.host;
    expect((await make().run(e)).statusCode).toBe(404);
  });

  test('step 2 (host): the apex appDomain gets 404', async () => {
    expect((await run(hostMode(), { host: HOST_DOMAIN, uri: '/' })).statusCode).toBe(404);
  });

  test('step 2 (host): a reserved label is no pooled host and has no entry: 404', async () => {
    expect((await run(hostMode(), { host: `www.${HOST_DOMAIN}`, uri: '/' })).statusCode).toBe(404);
  });

  test('step 2 (host): a pooled host logs its tenant before any later answer, SPA loads included', async () => {
    const r = hostMode();
    const a = await run(r, { host: ACME_HOST, uri: '/' });
    expect(a.uri).toBe('/index.html');
    expect(r.logs).toEqual([T_ACME]);
    expect(r.reads).toEqual([`host#${ACME_HOST}`]);
  });

  test('step 2 and 4 (host): a step 4 refusal on a looked-up host still names the tenant', async () => {
    const r = hostMode();
    const a = await run(r, { host: ACME_HOST, uri: '/api/x', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(a.statusCode).toBe(403);
    expect(r.logs).toEqual([T_ACME]);
  });

  test('step 2 (single): appDomain needs no host# lookup and logs nothing on SPA loads', async () => {
    const r = single();
    await run(r, { host: SINGLE_DOMAIN, uri: '/' });
    expect(r.reads).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  test('step 2 (single): a dedicated domain is looked up and its tenant logged', async () => {
    const r = single();
    await run(r, { host: DEDICATED_HOST, uri: '/' });
    expect(r.reads).toEqual([`host#${DEDICATED_HOST}`]);
    expect(r.logs).toEqual([T_DEDICATED]);
  });

  test('step 2 (single): an unknown dedicated domain gets 404', async () => {
    expect((await run(single(), { host: 'unknown.example.org', uri: '/' })).statusCode).toBe(404);
  });

  test('step 2 (single): login.<appDomain> is no sign-in host in single mode', async () => {
    const r = single();
    const a = await run(r, { host: `login.${SINGLE_DOMAIN}`, uri: '/callback', query: { state: 'x', code: 'y' } });
    expect(a.statusCode).toBe(404);
    expect(r.reads).toEqual([`host#login.${SINGLE_DOMAIN}`]);
  });

  test('step 2 and Telemetry: a host# entry whose t is not a stored id logs "-"', async () => {
    const r = hostMode();
    r.store.set(`host#odd.${HOST_DOMAIN}`, '{"v":1,"t":"Not An Id","ac":"111111111111"}');
    await run(r, { host: `odd.${HOST_DOMAIN}`, uri: '/' });
    expect(r.logs).toEqual(['-']);
  });
});

describe('step 3: the /agents path filter (ADR-0019, §10 step 23)', () => {
  const refused = [
    '/agents',
    '/agents/',
    '/agents/support-bot',
    '/agents/support-bot/invocations/',
    '/agents/Support-Bot/invocations',
    `/agents/${'a'.repeat(33)}/invocations`,
    '/agents/support-bot/delegations',
    '/agents//invocations',
    '/agents/%73upport-bot/invocations',
    '/agents/..%2fentitlements/invocations',
  ];

  describe.each([
    ['single', single, SINGLE_DOMAIN],
    ['host', hostMode, ACME_HOST],
  ] as const)('%s mode', (_mode, make, host) => {
    test.each(refused)('step 3: %s gets 404 with the static body and no rewrite', async (uri) => {
      const r = make();
      const e = event({ host, uri, method: 'POST', token: tokenFor(T_ACME) });
      const a = await r.run(e);
      expect(a.statusCode).toBe(404);
      expect(a.body).toEqual({ encoding: 'text', data: '{"status":404}' });
      expect(e.request.uri).toBe(uri);
    });

    test('step 3 and 7: POST /agents/support-bot/invocations?x=1 is rewritten to /support-bot/invocations, query kept', async () => {
      const r = make();
      const a = await run(r, { host, uri: '/agents/support-bot/invocations', method: 'POST', token: tokenFor(T_ACME), query: { x: '1' } });
      expect(a.statusCode).toBeUndefined();
      expect(a.uri).toBe('/support-bot/invocations');
      expect(a.querystring).toEqual({ x: { value: '1' } });
      expect(header(a, 'x-tenant-route')).toBe(T_ACME);
      expect(header(a, 'x-tenant-token')).toBeUndefined();
      expect(header(a, 'authorization')).toBe(`Bearer ${tokenFor(T_ACME)}`);
      expect(r.origins).toEqual([]);
    });

    test('step 3: /agents/entitlements/invocations fits the pattern and passes, rewritten', async () => {
      const a = await run(make(), { host, uri: '/agents/entitlements/invocations', method: 'POST', token: tokenFor(T_ACME) });
      expect(a.uri).toBe('/entitlements/invocations');
    });

    test('step 3: a 32-character backend passes', async () => {
      const a = await run(make(), { host, uri: `/agents/${'a'.repeat(32)}/invocations`, method: 'POST', token: tokenFor(T_ACME) });
      expect(a.uri).toBe(`/${'a'.repeat(32)}/invocations`);
    });

    test('step 3: /agents is refused before step 8 could rewrite it to /index.html', async () => {
      const a = await run(make(), { host, uri: '/agents' });
      expect(a.statusCode).toBe(404);
      expect(a.uri).toBeUndefined();
    });
  });

  test('step 3: with agentIngress off every /agents path gets 404, a well-formed one included', async () => {
    const r = loadRouter(tokenValues({ agentIngress: 'off' }));
    for (const uri of ['/agents/support-bot/invocations', '/agents', '/agents/']) {
      const a = await run(r, { host: SINGLE_DOMAIN, uri, method: 'POST', token: tokenFor(T_ACME) });
      expect(a.statusCode).toBe(404);
    }
  });

  test('step 3: a path that needs no tenant skips to step 8 even for a suspended tenant (host)', async () => {
    const a = await run(withSuspendedHost(hostMode()), { host: SUSPENDED_HOST, uri: '/dashboard' });
    expect(a.uri).toBe('/index.html');
  });

  test('step 3 and 8 (single): /signin-state skips steps 4 to 7 and gets 404', async () => {
    const r = single();
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/signin-state', headers: { 'sec-fetch-site': 'cross-site' }, query: { nonce: 'A'.repeat(16) } });
    expect(a.statusCode).toBe(404);
    expect(r.reads).toEqual([]);
  });
});

describe('step 4: Sec-Fetch-Site', () => {
  const paths = [
    ['single', single, SINGLE_DOMAIN, '/api/items'],
    ['single', single, SINGLE_DOMAIN, '/agents/support-bot/invocations'],
    ['host', hostMode, ACME_HOST, '/api/items'],
    ['host', hostMode, ACME_HOST, '/agents/support-bot/invocations'],
    ['host', hostMode, ACME_HOST, '/signin-state'],
  ] as const;

  test.each(paths)('step 4 (%s): %s %s refuses same-site and cross-site with 403', async (_m, make, host, uri) => {
    for (const site of ['same-site', 'cross-site']) {
      const a = await run(make(), { host, uri, token: tokenFor(T_ACME), headers: { 'sec-fetch-site': site }, query: { nonce: 'A'.repeat(16) } });
      expect(a.statusCode).toBe(403);
    }
  });

  test.each(paths)('step 4 (%s): %s %s allows same-origin, none and no header', async (_m, make, host, uri) => {
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}] as Record<string, string>[]) {
      const a = await run(make(), { host, uri, token: tokenFor(T_ACME), headers, query: { nonce: 'A'.repeat(16) } });
      expect([undefined, 200]).toContain(a.statusCode);
    }
  });

  test('step 4: SPA loads and /config.json are not checked', async () => {
    const r = hostMode();
    expect((await run(r, { host: ACME_HOST, uri: '/', headers: { 'sec-fetch-site': 'cross-site' } })).uri).toBe('/index.html');
    expect((await run(r, { host: ACME_HOST, uri: '/config.json', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200);
  });
});

describe('step 5: find the tenant', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const bad: [string, string | undefined][] = [
    ['no Authorization header', undefined],
    ['not a bearer token', 'Basic dXNlcjpwYXNz'],
    ['a token of two segments (signature removed)', `Bearer ${b64('{}')}.${b64('{"tenant_id":"x"}')}`],
    ['an undecodable payload', `Bearer ${b64('{}')}.!!!.sig`],
    ['a payload that is not JSON', `Bearer ${b64('{}')}.${b64('nope')}.sig`],
    ['a payload that is a JSON array', `Bearer ${b64('{}')}.${b64('["x"]')}.sig`],
    ['no tenant_id', `Bearer ${token({ sub: 'u' })}`],
    ['an empty tenant_id', `Bearer ${token({ tenant_id: '' })}`],
    ['a tenant_id that is not a string', `Bearer ${token({ tenant_id: 7 })}`],
    ['a tenants list', `Bearer ${token({ tenants: [T_ACME] })}`],
    ['a tenants list beside a tenant_id', `Bearer ${token({ tenant_id: T_ACME, tenants: [T_ACME] })}`],
  ];

  test.each(bad)('step 5 (single): %s gets 401 with WWW-Authenticate: Bearer and logs "-"', async (_n, auth) => {
    const r = single();
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', headers: auth === undefined ? {} : { authorization: auth } });
    expect(a.statusCode).toBe(401);
    expect(header(a, 'www-authenticate')).toBe('Bearer');
    expect(header(a, 'cache-control')).toBe('no-store');
    expect(r.logs).toEqual(['-']);
    expect(r.reads).toEqual([]);
  });

  test.each(bad)('step 5 (host): %s on /api/* gets 401 with WWW-Authenticate: Bearer', async (_n, auth) => {
    const a = await run(hostMode(), { host: ACME_HOST, uri: '/api/items', headers: auth === undefined ? {} : { authorization: auth } });
    expect(a.statusCode).toBe(401);
    expect(header(a, 'www-authenticate')).toBe('Bearer');
  });

  /** A valid token for Acme padded in its signature to an Authorization header of exactly `bytes` bytes. */
  function authOfLength(bytes: number): string {
    const base = `Bearer ${token({ tenant_id: T_ACME }, '')}`;
    return base + 's'.repeat(bytes - base.length);
  }

  test('step 5: a repeated Authorization header counts as no token: 401', async () => {
    for (const [make, host] of [[single, SINGLE_DOMAIN], [hostMode, ACME_HOST]] as const) {
      const e = event({ host, uri: '/agents/support-bot/invocations', method: 'POST' });
      e.request.headers.authorization = {
        value: `Bearer ${tokenFor(T_ACME)}`,
        multiValue: [{ value: `Bearer ${tokenFor(T_ACME)}` }, { value: `Bearer ${tokenFor(T_DEDICATED)}` }],
      };
      expect((await make().run(e)).statusCode).toBe(401);
    }
  });

  test('step 5: an Authorization header of 8,192 bytes is decoded', async () => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri: '/api/items', headers: { authorization: authOfLength(8192) } });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
  });

  test.each([
    ['single', single, SINGLE_DOMAIN, '/api/items'],
    ['single', single, SINGLE_DOMAIN, '/agents/support-bot/invocations'],
    ['host', hostMode, ACME_HOST, '/api/items'],
    ['host', hostMode, ACME_HOST, '/config.json'],
    ['host', hostMode, ACME_HOST, '/signin-state'],
    ['single', single, DEDICATED_HOST, '/config.json'],
  ] as const)('step 5 (%s): an Authorization header over 8,192 bytes on %s %s gets 401 before any decode', async (_m, make, host, uri) => {
    const r = make();
    const a = await run(r, { host, uri, headers: { authorization: authOfLength(8193) }, query: { nonce: 'A'.repeat(16) } });
    expect(a.statusCode).toBe(401);
    expect(header(a, 'www-authenticate')).toBe('Bearer');
    expect(r.reads.filter((k) => k.startsWith('tenant#'))).toEqual([]);
  });

  test('step 5: the cap counts bytes, not characters', async () => {
    const base = `Bearer ${token({ tenant_id: T_ACME }, '')}`;
    const auth = base + 'é'.repeat(Math.ceil((8193 - base.length) / 2));
    expect(auth.length).toBeLessThanOrEqual(8192);
    expect((await run(single(), { host: SINGLE_DOMAIN, uri: '/api/items', headers: { authorization: auth } })).statusCode).toBe(401);
  });

  test('step 5 (single): the claim is lower-cased, routed on and logged', async () => {
    const r = single();
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_ACME.toUpperCase()) });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    expect(r.logs).toEqual([T_ACME]);
  });

  test('step 5 (single): "bearer" is matched case-insensitively', async () => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri: '/api/items', headers: { authorization: `bearer ${tokenFor(T_ACME)}` } });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
  });

  test('step 5 (single): on a dedicated domain the claim replaces the host tenant in the log', async () => {
    const r = single();
    const a = await run(r, { host: DEDICATED_HOST, uri: '/api/items', token: tokenFor(T_ACME) });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    expect(r.logs).toEqual([T_DEDICATED, T_ACME]);
  });

  test('step 5 (single): a claim outside the §4.1 id form is logged as "-" and gets 403 without a lookup', async () => {
    const r = single();
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor('Acme Corp/../x') });
    expect(a.statusCode).toBe(403);
    expect(r.logs).toEqual(['-']);
    expect(r.reads).toEqual([]);
  });

  test('step 5: the claim name is the tenantClaim input', async () => {
    const r = loadRouter(tokenValues({ tenantClaim: 'custom:tenant' }));
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: token({ 'custom:tenant': T_ACME, 'tenant_id': T_DEDICATED }) });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    const b = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_ACME) });
    expect(b.statusCode).toBe(401);
  });

  test('step 5 (host): a claim for another tenant than the host gets 403 on /api/* and /agents/*', async () => {
    for (const uri of ['/api/items', '/agents/support-bot/invocations']) {
      const r = hostMode();
      const a = await run(r, { host: ACME_HOST, uri, method: 'POST', token: tokenFor(T_DEDICATED) });
      expect(a.statusCode).toBe(403);
      expect(r.origins).toEqual([]);
      expect(r.reads).toEqual([`host#${ACME_HOST}`]);
    }
  });

  test('step 5 (host): the comparison is on the lower-cased claim, and the host tenant stays the logged one', async () => {
    const r = hostMode();
    const a = await run(r, { host: ACME_HOST, uri: '/api/items', token: tokenFor(T_ACME.toUpperCase()) });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    expect(r.logs).toEqual([T_ACME]);
  });

  test('step 5 (host): /config.json and /signin-state need no token', async () => {
    const r = hostMode();
    expect((await run(r, { host: ACME_HOST, uri: '/config.json' })).statusCode).toBe(200);
    expect((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: 'A'.repeat(16) } })).statusCode).toBe(200);
  });
});

describe('step 6: the tenant route (§4.2)', () => {
  test('step 6 (single): an unknown tenant gets 403', async () => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor('01hzx8k9p0qrst7vwxyz1a2b3z') });
    expect(a.statusCode).toBe(403);
    expect(header(a, 'cache-control')).toBe('no-store');
  });

  test('step 6 (host): a host# entry with no tenant# entry gets 403 on tenant paths', async () => {
    const r = hostMode();
    r.store.set(`host#left.${HOST_DOMAIN}`, '{"v":1,"t":"left","ac":"111111111111"}');
    for (const uri of ['/config.json', '/signin-state', '/api/items']) {
      const a = await run(r, { host: `left.${HOST_DOMAIN}`, uri, token: tokenFor('left'), query: { nonce: 'A'.repeat(16) } });
      expect(a.statusCode).toBe(403);
    }
  });

  test.each([
    ['single', single, SINGLE_DOMAIN, '/api/items'],
    ['single', single, SINGLE_DOMAIN, '/agents/support-bot/invocations'],
    ['host', () => withSuspendedHost(hostMode()), SUSPENDED_HOST, '/api/items'],
    ['host', () => withSuspendedHost(hostMode()), SUSPENDED_HOST, '/agents/support-bot/invocations'],
    ['host', () => withSuspendedHost(hostMode()), SUSPENDED_HOST, '/config.json'],
    ['host', () => withSuspendedHost(hostMode()), SUSPENDED_HOST, '/signin-state'],
  ] as const)('step 6 (%s): a suspended tenant on %s %s gets 503 with Retry-After: 300', async (_m, make, host, uri) => {
    const r = make();
    const a = await run(r, { host, uri, method: 'POST', token: tokenFor(T_SUSPENDED), query: { nonce: 'A'.repeat(16) } });
    expect(a.statusCode).toBe(503);
    expect(header(a, 'retry-after')).toBe('300');
    expect(r.origins).toEqual([]);
  });

  test('step 6: a tenant with no host# entry is routed in single mode', async () => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_NO_HOST) });
    expect(header(a, 'x-tenant-route')).toBe(T_NO_HOST);
  });
});

describe('§4.1 and step 6: route table values the router refuses (route-table.json invalid cases)', () => {
  const rt: { invalid: { kind: string; why: string; value: string }[] } = readFixture('route-table.json');
  const cases: Record<string, [() => Router, string, string, string, number]> = {
    tenant: [single, `tenant#${T_ACME}`, SINGLE_DOMAIN, '/api/items', 403],
    host: [hostMode, `host#${ACME_HOST}`, ACME_HOST, '/', 404],
    cell: [single, 'cell#01hzx8k9p0qrst7vwxyz1a2b3d', SINGLE_DOMAIN, '/api/items', 503],
    app: [single, 'app', SINGLE_DOMAIN, '/config.json', 503],
    signin: [hostMode, 'signin', ACME_HOST, '/signin-state', 503],
  };

  /** Pairing rules on fields the router never reads (§4.1): the registrar refuses them, the router routes on. */
  const unread = ['dk without d', 'd without dk'];

  test.each(rt.invalid.filter((c) => !unread.includes(c.why)).map((c) => [c.kind, c.why, c] as const))(
    '§4.1: a %s value with %s is treated as no entry', async (kind, _why, c) => {
      const [make, key, host, uri, expected] = cases[kind];
      const r = make();
      r.store.set(key, c.value);
      const a = await run(r, { host, uri, token: tokenFor(T_ACME), query: { nonce: 'A'.repeat(16) } });
      expect(a.statusCode).toBe(expected);
    });

  test.each(unread)('§4.1: a tenant value with %s still routes, the router never reads d or dk', async (why) => {
    const r = single();
    const value = JSON.parse(rt.invalid.find((c) => c.why === why)!.value);
    r.store.set(`tenant#${T_ACME}`, JSON.stringify({ ...value, c: '01hzx8k9p0qrst7vwxyz1a2b3d' }));
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_ACME) });
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
  });

  test('§4.1: a signin key that is not 32 bytes makes the entry no entry', async () => {
    const r = hostMode();
    r.store.set('signin', '{"v":1,"cur":"k1","k":{"k1":"AAAA"}}');
    expect((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: 'A'.repeat(16) } })).statusCode).toBe(503);
  });

  test('step 2 and 6: a host# entry with an empty t gets 403 on /config.json, not a tenant-less file', async () => {
    const r = hostMode();
    r.store.set(`host#empty.${HOST_DOMAIN}`, '{"v":1,"t":"","ac":"111111111111"}');
    expect((await run(r, { host: `empty.${HOST_DOMAIN}`, uri: '/config.json' })).statusCode).toBe(403);
  });

  test('every valid route-table.json entry is accepted by the parser the router uses', async () => {
    const r = hostMode();
    const routed = await run(r, { host: ACME_HOST, uri: '/api/items', token: tokenFor(T_ACME) });
    expect(status(routed)).toBe('forwarded');
    for (const host of [ACME_HOST, `${T_DEDICATED}.${HOST_DOMAIN}`, DEDICATED_HOST]) {
      expect((await run(r, { host, uri: '/config.json' })).statusCode).toBe(200);
    }
    for (const t of [T_NO_HOST]) {
      expect(header(await run(single(), { host: SINGLE_DOMAIN, uri: '/api/x', token: tokenFor(t) }), 'x-tenant-route')).toBe(t);
    }
    expect((await run(r, { host: ACME_HOST, uri: '/signin-state', query: { nonce: 'A'.repeat(16) } })).statusCode).toBe(200);
  });
});

describe('step 7: routing to the cell and the agent ingress', () => {
  test.each([
    ['single', single, SINGLE_DOMAIN],
    ['host', hostMode, ACME_HOST],
  ] as const)('step 7 (%s): /api/* goes to the cell API domain with origin access control (S-3)', async (_m, make, host) => {
    const r = make();
    const e = event({ host, uri: '/api/items/1', method: 'PUT', token: tokenFor(T_ACME), query: { a: 'b' } });
    const a = await r.run(e);
    expect(a.statusCode).toBeUndefined();
    expect(r.origins).toEqual([{
      domainName: CELL_ORIGIN,
      originAccessControlConfig: { enabled: true, signingBehavior: 'always', signingProtocol: 'sigv4', originType: 'lambda' },
    }]);
    expect(header(a, 'x-tenant-token')).toBe(tokenFor(T_ACME));
    expect(header(a, 'x-tenant-route')).toBe(T_ACME);
    expect(a.uri).toBe('/api/items/1');
    expect(a.querystring).toEqual({ a: { value: 'b' } });
  });

  test('step 7: a tenant whose cell has no route gets 503', async () => {
    const r = single();
    r.store.delete('cell#01hzx8k9p0qrst7vwxyz1a2b3d');
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api/items', token: tokenFor(T_ACME) });
    expect(a.statusCode).toBe(503);
    expect(header(a, 'retry-after')).toBeUndefined();
    expect(r.origins).toEqual([]);
  });

  test('step 7 and the read bound: /api/* on a looked-up host reads host#, tenant# and cell#, no more', async () => {
    const r = hostMode();
    await run(r, { host: DEDICATED_HOST, uri: '/api/items', token: tokenFor(T_DEDICATED) });
    expect(r.reads).toEqual([`host#${DEDICATED_HOST}`, `tenant#${T_DEDICATED}`, 'cell#01hzx8k9p0qrst7vwxyz1a2b3d']);
  });

  test('step 7: /api without a slash is an SPA route, not the API', async () => {
    const r = single();
    const a = await run(r, { host: SINGLE_DOMAIN, uri: '/api' });
    expect(a.uri).toBe('/index.html');
    expect(r.origins).toEqual([]);
  });
});

describe('step 8: /config.json (config-json.json)', () => {
  const f: { cases: { name: string; addressing: 'single' | 'host'; host: string; body: unknown }[] } = readFixture('config-json.json');

  test.each(f.cases.map((c) => [c.name, c] as const))('step 8: %s equals the fixture body', async (_n, c) => {
    const r = c.addressing === 'host' ? hostMode() : single();
    const a = await run(r, { host: c.host, uri: '/config.json' });
    expect(a.statusCode).toBe(200);
    expect(header(a, 'content-type')).toBe('application/json');
    expect(header(a, 'cache-control')).toBe('no-store');
    expect(JSON.parse(a.body!.data)).toEqual(c.body);
    expect(r.reads.length).toBeLessThanOrEqual(3);
  });

  test('step 8: without exchangeEndpoint in app, /config.json has none', async () => {
    const r = single();
    r.store.set('app', '{"v":1,"az":"https://auth.example.com/a","tk":"https://auth.example.com/t","cid":"c","sc":"openid","lo":"https://auth.example.com/l"}');
    const body = JSON.parse((await run(r, { host: SINGLE_DOMAIN, uri: '/config.json' })).body!.data);
    expect(body).toEqual({ authorizeEndpoint: 'https://auth.example.com/a', tokenEndpoint: 'https://auth.example.com/t', clientId: 'c', scopes: 'openid' });
  });

  test('step 8 (single): a dedicated domain whose tenant is suspended gets 503 on /config.json', async () => {
    const r = single();
    r.store.set('host#shop.example.net', `{"v":1,"t":"${T_SUSPENDED}","ac":"111111111111"}`);
    expect((await run(r, { host: 'shop.example.net', uri: '/config.json' })).statusCode).toBe(503);
  });
});

describe('step 8: /logout (§3.5)', () => {
  test('step 8 (single): 302 to the issuer logout with client_id and logout_uri, and Clear-Site-Data', async () => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri: '/logout' });
    expect(a.statusCode).toBe(302);
    expect(header(a, 'location')).toBe(
      'https://auth.example.com/logout?client_id=exampleclientid&logout_uri=https%3A%2F%2Fapp.example.com%2F');
    expect(header(a, 'clear-site-data')).toBe('"storage", "cache"');
    expect(header(a, 'cache-control')).toBe('no-store');
  });

  test('step 8 (single): /logout on a dedicated domain also signs out through appDomain', async () => {
    const a = await run(single(), { host: DEDICATED_HOST, uri: '/logout' });
    expect(header(a, 'location')).toContain('logout_uri=https%3A%2F%2Fapp.example.com%2F');
  });

  test('step 3 and 8 (host): /logout needs only the host# entry, so a suspended tenant can still sign out', async () => {
    const a = await run(withSuspendedHost(hostMode()), { host: SUSPENDED_HOST, uri: '/logout' });
    expect(a.statusCode).toBe(302);
  });

  test('step 8 (host): /logout on a dedicated domain gets 400', async () => {
    expect((await run(hostMode(), { host: DEDICATED_HOST, uri: '/logout' })).statusCode).toBe(400);
  });

  test('step 8 (host): /logout on an unknown host gets 404 (step 2)', async () => {
    expect((await run(hostMode(), { host: `nobody.${HOST_DOMAIN}`, uri: '/logout' })).statusCode).toBe(404);
  });
});

describe('step 8: the SPA rewrite', () => {
  test.each([
    ['/', '/index.html'],
    ['/dashboard', '/index.html'],
    ['/callback', '/index.html'],
    ['/a.b/settings', '/index.html'],
    ['/assets/index-3f9a1c.js', '/assets/index-3f9a1c.js'],
    ['/favicon.ico', '/favicon.ico'],
    ['/index.html', '/index.html'],
  ])('step 8: %s goes to the origin as %s', async (uri, expected) => {
    const a = await run(single(), { host: SINGLE_DOMAIN, uri, query: { q: '1' } });
    expect(a.statusCode).toBeUndefined();
    expect(a.uri).toBe(expected);
    expect(a.querystring).toEqual({ q: { value: '1' } });
  });
});

describe('§5.3 edge errors', () => {
  test('§5.3: every refusal has a small static JSON body and no-store', async () => {
    const r = single();
    const answers = [
      await run(r, { host: SINGLE_DOMAIN, uri: '/api/x' }),
      await run(r, { host: SINGLE_DOMAIN, uri: '/api/x', token: tokenFor('01hzx8k9p0qrst7vwxyz1a2b3z') }),
      await run(r, { host: 'unknown.example.org', uri: '/' }),
      await run(r, { host: SINGLE_DOMAIN, uri: '/api/x', token: tokenFor(T_SUSPENDED) }),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([401, 403, 404, 503]);
    for (const a of answers) {
      expect(header(a, 'cache-control')).toBe('no-store');
      expect(header(a, 'content-type')).toBe('application/json');
      expect(a.body!.data).toBe(`{"status":${a.statusCode}}`);
    }
  });
});
