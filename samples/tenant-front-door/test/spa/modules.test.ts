// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** The SPA's pure modules (spec §3.2, §3.5, §7.2), in Node with no DOM. */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { configCase, configCases, fakeFetch, json, jwt, memoryStorage, streamOf } from './support';
import { apiRequest, contentSha256, whoami } from '../../spa/src/api';
import { ConfigError, parseConfig, signInPlan } from '../../spa/src/config';
import { base64UrlDecodeText, base64UrlEncode } from '../../spa/src/encoding';
import { withSignal } from '../../spa/src/http';
import { codeChallenge, makeVerifier } from '../../spa/src/pkce';
import {
  authorizeUrl, makeNonce, parseCallback, parseSigninState, PENDING_KEY, savePending, signinStatePath, stateMatches, stateNonce, takePending,
} from '../../spa/src/signin';
import { AgentError, invokeAgent, MAX_EVENT_CHARS, readEventStream, StreamEvent } from '../../spa/src/stream';
import { decodeClaims, namesTenant, redeemCode, SignInError, tenantView } from '../../spa/src/token';
import { HEADER_CONTENT_SHA256, SIGNIN_NONCE } from '../../src/shared/contracts';

const signinFixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/signin-state.json'), 'utf8'));
const hostPooled = configCase('host, pooled tenant host').body;

describe('encoding and PKCE (§3.5, RFC 7636)', () => {
  test('S256 challenge matches RFC 7636 appendix B', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('verifier is 43 base64url characters and differs per call', () => {
    const a = makeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeVerifier()).not.toBe(a);
  });

  test('base64url round trip, and refusal of non-base64url input', () => {
    const bytes = new Uint8Array([251, 255, 0, 62, 63]);
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    expect(base64UrlDecodeText(Buffer.from('héllo', 'utf8').toString('base64url'))).toBe('héllo');
    expect(() => base64UrlDecodeText('ab+/')).toThrow();
    expect(() => base64UrlDecodeText('a')).toThrow();
    expect(() => base64UrlDecodeText(Buffer.from([0xff, 0xfe]).toString('base64url'))).toThrow();
  });
});

describe('/config.json (§3.2, ADR-0006)', () => {
  const plans: Record<string, ReturnType<typeof signInPlan>> = {
    'single, appDomain': { kind: 'here', mode: 'single', redirectUri: 'https://app.example.com/', expectedTenant: undefined },
    'single, dedicated domain': { kind: 'redirect', url: 'https://app.example.com/' },
    'host, pooled tenant host': {
      kind: 'here', mode: 'host', redirectUri: 'https://login.tenants.example.com/callback', expectedTenant: '01HZX8K9P0QRST7VWXYZ1A2B3C',
    },
    'host, dedicated domain': { kind: 'redirect', url: 'https://01hzx8k9p0qrst7vwxyz1a2b3e.tenants.example.com/' },
  };

  test.each(configCases.map((c) => [c.name, c] as const))('%s: parses and plans sign-in per §3.5', (name, c) => {
    const config = parseConfig(c.body);
    expect(config).toEqual(Object.fromEntries(Object.entries(c.body).filter(([k]) => k !== 'rev')));
    expect(signInPlan(config, { host: c.host, origin: `https://${c.host}` })).toEqual(plans[name]);
  });

  test.each([
    ['not an object', []],
    ['missing clientId', { ...hostPooled, clientId: undefined }],
    ['http token endpoint', { ...hostPooled, tokenEndpoint: 'http://auth.example.com/oauth2/token' }],
    ['credentials in a URL', { ...hostPooled, authorizeEndpoint: 'https://u:p@auth.example.com/' }],
    ['exchangeEndpoint not a URL', { ...hostPooled, exchangeEndpoint: 'api.example.com' }],
    ['signInHost with a path', { ...hostPooled, signInHost: 'a.example.com/x' }],
    ['signInHost upper case', { ...hostPooled, signInHost: 'A.example.com' }],
    ['tenantId not a string', { ...hostPooled, tenantId: 7 }],
  ])('refuses %s', (_n, raw) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
  });
});

describe('sign-in state and nonce (§3.5 steps 1 to 4, ADR-0016)', () => {
  test('nonce fits SIGNIN_NONCE and the /signin-state query', () => {
    const n = makeNonce();
    expect(n).toMatch(SIGNIN_NONCE);
    expect(signinStatePath(n)).toBe(`/signin-state?nonce=${n}`);
  });

  test('pending values are read once and deleted on every outcome (§3.5 step 4)', () => {
    const s = memoryStorage();
    savePending(s, { verifier: 'v'.repeat(43), nonce: 'AbCdEfGhIjKlMnOp_-0123' });
    expect(takePending(s)).toEqual({ verifier: 'v'.repeat(43), nonce: 'AbCdEfGhIjKlMnOp_-0123' });
    expect(s.map.size).toBe(0);
    expect(takePending(s)).toBeUndefined();
    s.setItem(PENDING_KEY, '{not json');
    expect(takePending(s)).toBeUndefined();
    expect(s.map.size).toBe(0);
    s.setItem(PENDING_KEY, JSON.stringify({ v: 1, verifier: 'x', nonce: 'short' }));
    expect(takePending(s)).toBeUndefined();
    expect(s.map.size).toBe(0);
  });

  test('host mode: the router state carries the nonce as n (signin-state.json)', () => {
    const [withNonce, logout] = signinFixture.valid;
    const pending = { verifier: 'v', nonce: withNonce.payload.n };
    expect(stateNonce(withNonce.state, 'host')).toBe(withNonce.payload.n);
    expect(stateMatches(withNonce.state, 'host', pending)).toBe(true);
    expect(stateMatches(withNonce.state, 'host', { verifier: 'v', nonce: 'ZZZZZZZZZZZZZZZZZZZZZZ' })).toBe(false);
    expect(stateMatches(logout.state, 'host', pending)).toBe(false);
  });

  const malformed: [string, string][] = signinFixture.invalid.filter((c: any) => c.why === 'shape').map((c: any) => [c.name, c.state]);
  test.each(malformed)('host mode: a malformed state (%s) carries no nonce', (_n, state) => {
    expect(stateMatches(state, 'host', { verifier: 'v', nonce: 'AbCdEfGhIjKlMnOp_-0123' })).toBe(false);
  });

  test('single mode: the state is the nonce itself', () => {
    const pending = { verifier: 'v', nonce: 'AbCdEfGhIjKlMnOp_-0123' };
    expect(stateMatches('AbCdEfGhIjKlMnOp_-0123', 'single', pending)).toBe(true);
    expect(stateMatches('AbCdEfGhIjKlMnOp_-0124', 'single', pending)).toBe(false);
  });

  test('callback query: code and state, error, nothing, or malformed (§3.5 step 4, §7.2)', () => {
    expect(parseCallback('?code=c1&state=s1')).toEqual({ kind: 'code', code: 'c1', state: 's1' });
    expect(parseCallback('?error=access_denied&error_description=%3Cb%3Ex%3C%2Fb%3E')).toEqual({ kind: 'error' });
    expect(parseCallback('?code=c1&state=s1&error=x')).toEqual({ kind: 'error' });
    expect(parseCallback('')).toEqual({ kind: 'none' });
    expect(parseCallback('?code=c1')).toEqual({ kind: 'error' });
    expect(parseCallback('?code=a&code=b&state=s')).toEqual({ kind: 'error' });
  });

  test('authorize URL carries the code challenge, state and redirect_uri (§3.5 step 2)', () => {
    const u = new URL(authorizeUrl(hostPooled, { redirectUri: hostPooled.redirectUri!, state: 'st', challenge: 'ch' }));
    expect(u.origin + u.pathname).toBe(hostPooled.authorizeEndpoint);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'exampleclientid',
      redirect_uri: 'https://login.tenants.example.com/callback',
      scope: 'openid sample/read',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  test('/signin-state answer must hold a state', () => {
    expect(parseSigninState({ state: 'abc.def' })).toBe('abc.def');
    expect(() => parseSigninState({})).toThrow();
    expect(() => parseSigninState(null)).toThrow();
  });
});

describe('tokens (§3.5, ADR-0007)', () => {
  test('code exchange is a form POST with the verifier and the same redirect_uri, no credentials', async () => {
    const f = fakeFetch(() => json(200, { access_token: 'a', refresh_token: 'r', id_token: 'i' }));
    await expect(redeemCode(f, hostPooled, { code: 'c', verifier: 'v', redirectUri: 'https://login.tenants.example.com/callback' }))
      .resolves.toEqual({ accessToken: 'a', refreshToken: 'r' });
    const [{ url, init }] = f.calls;
    expect(url).toBe(hostPooled.tokenEndpoint);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(init.headers).toBeUndefined();
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'exampleclientid',
      code: 'c',
      redirect_uri: 'https://login.tenants.example.com/callback',
      code_verifier: 'v',
    });
  });

  test('code exchange failures throw SignInError', async () => {
    const args = { code: 'c', verifier: 'v', redirectUri: 'https://app.example.com/' };
    await expect(redeemCode(fakeFetch(() => json(400, { error: 'invalid_grant' })), hostPooled, args)).rejects.toThrow(SignInError);
    await expect(redeemCode(fakeFetch(() => json(200, {})), hostPooled, args)).rejects.toThrow(SignInError);
    await expect(redeemCode(fakeFetch(() => Promise.reject(new TypeError('net'))), hostPooled, args)).rejects.toThrow(SignInError);
  });

  test('tenant claims: one tenant, a tenants list, or neither (§3.3 step 5)', () => {
    expect(tenantView(decodeClaims(jwt({ tenant_id: 'A1' })))).toEqual({ kind: 'single', tenantId: 'A1' });
    expect(tenantView(decodeClaims(jwt({ tenants: ['A1', 'B2'] })))).toEqual({ kind: 'multi', tenants: ['A1', 'B2'] });
    expect(tenantView(decodeClaims(jwt({ tenants: [] })))).toEqual({ kind: 'none' });
    expect(tenantView(decodeClaims(jwt({ tenants: 'A1' })))).toEqual({ kind: 'none' });
    expect(tenantView(decodeClaims(jwt({ sub: 'x' })))).toEqual({ kind: 'none' });
    expect(decodeClaims('not-a-jwt')).toBeUndefined();
    expect(decodeClaims('a.!!.c')).toBeUndefined();
  });

  test('tenant claims: the tenantClaim /config.json names, not tenant_id (§3.2, §3.6)', () => {
    const claims = decodeClaims(jwt({ 'custom:tenant': 'A1', 'tenant_id': 'B2' }));
    expect(tenantView(claims, 'custom:tenant')).toEqual({ kind: 'single', tenantId: 'A1' });
    expect(namesTenant(claims, 'A1', 'custom:tenant')).toBe(true);
    expect(namesTenant(claims, 'B2', 'custom:tenant')).toBe(false);
  });

  test('namesTenant compares case-insensitively and refuses a tenants list (§3.5 step 4)', () => {
    expect(namesTenant(decodeClaims(jwt({ tenant_id: '01hzx8k9p0qrst7vwxyz1a2b3c' })), '01HZX8K9P0QRST7VWXYZ1A2B3C')).toBe(true);
    expect(namesTenant(decodeClaims(jwt({ tenant_id: 'OTHER' })), '01HZX8K9P0QRST7VWXYZ1A2B3C')).toBe(false);
    expect(namesTenant(decodeClaims(jwt({ tenant_id: 'A', tenants: ['A'] })), 'A')).toBe(false);
  });
});

test('withSignal binds every call to the signal and keeps the rest of the request (§7.2)', async () => {
  const f = fakeFetch(() => json(200, {}));
  const c = new AbortController();
  await withSignal(f, c.signal)('/api/whoami', { method: 'GET', credentials: 'same-origin' });
  expect(f.calls[0].init).toEqual({ method: 'GET', credentials: 'same-origin', signal: c.signal });
});

describe('cell API calls (§3.2, §7.2, ADR-0011)', () => {
  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  test.each(['POST', 'PUT'] as const)('%s sends the body SHA-256 in x-amz-content-sha256', async (method) => {
    const f = fakeFetch(() => json(200, {}));
    await apiRequest(f, 'tok', method, '/api/items', '{"a":"é"}');
    const { url, init } = f.calls[0];
    expect(url).toBe('/api/items');
    expect(init.headers).toEqual({ 'Authorization': 'Bearer tok', 'Content-Type': 'application/json', [HEADER_CONTENT_SHA256]: sha('{"a":"é"}') });
    expect(init.credentials).toBe('same-origin');
  });

  test('an empty POST body hashes the empty string', async () => {
    expect(await contentSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('GET whoami sends only Authorization and returns the answer (§10 step 4)', async () => {
    const f = fakeFetch(() => json(200, { tenantId: 'A1' }));
    await expect(whoami(f, 'tok')).resolves.toEqual({ tenantId: 'A1' });
    expect(f.calls[0]).toEqual({ url: '/api/whoami', init: { method: 'GET', headers: { Authorization: 'Bearer tok' }, body: undefined, credentials: 'same-origin' } });
    await expect(whoami(fakeFetch(() => json(403, {})), 'tok')).rejects.toThrow('403');
  });

  test('refuses a path outside /api/ and a GET body', async () => {
    const f = fakeFetch(() => json(200, {}));
    await expect(apiRequest(f, 't', 'GET', '/agents/x')).rejects.toThrow();
    await expect(apiRequest(f, 't', 'GET', '/api/x', 'b')).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe('streamed agent replies (§7.2)', () => {
  async function events(chunks: (string | Uint8Array)[]): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    await readEventStream(streamOf(chunks), (e) => out.push(e));
    return out;
  }

  test('parses data, event, comments and multi-line data', async () => {
    expect(await events([': hello\n', 'data: one\n\n', 'event: usage\ndata: {"in":1}\ndata: {"out":2}\n\n'])).toEqual([
      { event: 'message', data: 'one' },
      { event: 'usage', data: '{"in":1}\n{"out":2}' },
    ]);
  });

  test('handles CRLF split across chunks, CR line ends, and UTF-8 split across chunks', async () => {
    const euro = new TextEncoder().encode('data: €\n\n');
    expect(await events(['data: a\r', '\n\r\n', 'data: b\r\r', euro.slice(0, 7), euro.slice(7)])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
      { event: 'message', data: '€' },
    ]);
  });

  test('drops an event the stream ends inside, and a field with no colon', async () => {
    expect(await events(['data\n\n', 'data: tail'])).toEqual([{ event: 'message', data: '' }]);
  });

  test('refuses an event over the size cap', async () => {
    await expect(events(['data: ', 'x'.repeat(MAX_EVENT_CHARS + 1)])).rejects.toThrow('too large');
  });

  test('POSTs the prompt to /agents/<backend>/invocations with the bearer token', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}), body: streamOf(['data: hi\n\n']) }));
    const got: StreamEvent[] = [];
    await invokeAgent(f, 'tok', 'support-bot', 'hello', (e) => got.push(e));
    expect(got).toEqual([{ event: 'message', data: 'hi' }]);
    expect(f.calls[0]).toEqual({
      url: '/agents/support-bot/invocations',
      init: {
        method: 'POST',
        headers: { 'Authorization': 'Bearer tok', 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: '{"prompt":"hello"}',
        credentials: 'same-origin',
      },
    });
  });

  test('refuses a backend name the router would not forward (§3.3 step 3), and reports the status', async () => {
    const f = fakeFetch(() => json(401, {}));
    await expect(invokeAgent(f, 't', '../x', 'p', () => undefined)).rejects.toThrow('backend');
    await expect(invokeAgent(f, 't', 'Support-Bot', 'p', () => undefined)).rejects.toThrow('backend');
    await expect(invokeAgent(f, 't', 'ok', 'p', () => undefined)).rejects.toThrow(AgentError);
  });
});
