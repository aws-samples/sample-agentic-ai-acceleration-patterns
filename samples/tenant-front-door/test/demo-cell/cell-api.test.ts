// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from 'jose';
import { createCellApi, tokenFromHeader, type LogRecord } from '../../src/demo-cell/cell-api';
import { HostsCheck } from '../../src/demo-cell/hosts';
import { TenantLimiter, windowKey } from '../../src/demo-cell/limiter';
import { TokenVerifier } from '../../src/demo-cell/token';

const ISSUER = 'https://issuer.example.com/pool';
const JWKS_URL = 'https://issuer.example.com/pool/.well-known/jwks.json';
const CLIENT = 'spa-client';
const APP = 'demo';
const CELL = 'cell-a';
const TENANT_A = '01HZX8K9P0QRST7VWXYZ1A2B3C';
const TENANT_B = '01HZX8K9P0QRST7VWXYZ1A2B3D';
const NOW = Date.UTC(2026, 10, 20, 12, 1, 0);

const ssm = mockClient(SSMClient);
const dynamo = mockClient(DynamoDBClient);

let privateKey: CryptoKey;
let publicJwk: JWK;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

beforeEach(() => {
  ssm.reset();
  dynamo.reset();
  ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: 'x', Value: 'y' }] });
  dynamo.on(UpdateItemCommand).resolves({});
});

interface TokenOptions {
  readonly header?: Record<string, unknown>;
  readonly key?: CryptoKey;
  readonly expiresIn?: number;
  readonly issuer?: string;
}

async function token(claims: JWTPayload, options: TokenOptions = {}): Promise<string> {
  // jose checks exp against the real clock, not NOW.
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ client_id: CLIENT, token_use: 'access', sub: 'user-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', ...options.header })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? privateKey);
}

function event(headers: Record<string, string>, method = 'GET', rawPath = '/api/whoami'): LambdaFunctionURLEvent {
  return { rawPath, headers, requestContext: { http: { method } } } as unknown as LambdaFunctionURLEvent;
}

interface Setup {
  readonly tenantClaim?: string;
  readonly limit?: number;
  readonly verifier?: TokenVerifier;
}

function setup(options: Setup = {}) {
  const records: LogRecord[] = [];
  const failOpen: string[] = [];
  const verifier =
    options.verifier ??
    new TokenVerifier(
      { issuer: ISSUER, jwksUrl: JWKS_URL, allowedClientIds: [CLIENT], tenantClaim: options.tenantClaim ?? 'tenant_id' },
      { getKey: createLocalJWKSet({ keys: [publicJwk] }) },
    );
  const api = createCellApi({
    cellId: CELL,
    verifier,
    hosts: new HostsCheck(APP, { ssm: new SSMClient({ region: 'eu-central-1' }), now: () => NOW }),
    limiter: new TenantLimiter(
      { tableName: 'limits', requestsPer5Min: options.limit ?? 2000 },
      { dynamo: new DynamoDBClient({ region: 'eu-central-1' }), now: () => NOW, onError: (tenantId) => failOpen.push(tenantId) },
    ),
    log: (r) => records.push(r),
  });
  return { api, records, failOpen };
}

async function call(api: ReturnType<typeof setup>['api'], headers: Record<string, string>, method?: string, path?: string) {
  const res = await api(event(headers, method, path));
  return { status: res.statusCode, headers: res.headers ?? {}, body: JSON.parse(String(res.body)) };
}

const forA = async (claims: JWTPayload = {}, options?: TokenOptions) => token({ tenant_id: TENANT_A, ...claims }, options);

describe('demo cell API: GET /api/whoami (spec §10 step 4, §3.5)', () => {
  test('answers the verified tenant in control-plane form, the cell id and the route hint, from the token in x-tenant-token', async () => {
    const { api, records } = setup();
    const res = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: TENANT_A, cellId: CELL, routeHint: TENANT_A.toLowerCase() });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(records).toEqual([expect.objectContaining({ message: 'served', status: 200, tenantId: TENANT_A, routeTenantId: TENANT_A.toLowerCase() })]);
  });

  test('upper-cases a lower-case claim and builds the hosts-check path from it, never from the hint (§3.5)', async () => {
    const { api } = setup();
    const res = await call(api, { 'x-tenant-token': await token({ tenant_id: TENANT_A.toLowerCase() }), 'x-tenant-route': TENANT_A.toLowerCase() });
    expect(res.body.tenantId).toBe(TENANT_A);
    expect(ssm.commandCalls(GetParametersByPathCommand)[0].args[0].input).toEqual({
      Path: `/application-plane/tenants/${TENANT_A}/${APP}`,
      Recursive: true,
      MaxResults: 1,
      NextToken: undefined,
    });
  });

  test('accepts a Bearer-prefixed x-tenant-token value (ADR-0011)', async () => {
    expect(tokenFromHeader('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(tokenFromHeader(' abc.def.ghi ')).toBe('abc.def.ghi');
    expect(tokenFromHeader(undefined)).toBeUndefined();
    const { api } = setup();
    const res = await call(api, { 'x-tenant-token': `Bearer ${await forA()}`, 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(200);
  });

  test('reads the configured tenantClaim (§3.6)', async () => {
    const { api } = setup({ tenantClaim: 'custom:tenant' });
    const res = await call(api, { 'x-tenant-token': await token({ 'custom:tenant': TENANT_B }), 'x-tenant-route': TENANT_B.toLowerCase() });
    expect(res.body.tenantId).toBe(TENANT_B);
    const noClaim = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    expect(noClaim.status).toBe(403);
  });

  test('answers 404 for any other route or method, after the checks', async () => {
    const { api } = setup();
    const t = await forA();
    expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A }, 'GET', '/api/other')).status).toBe(404);
    expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A }, 'POST', '/api/whoami')).status).toBe(404);
    const unverified = await call(api, { 'x-tenant-route': TENANT_A }, 'GET', '/api/other');
    expect(unverified.status).toBe(403);
  });
});

describe('demo cell API: token refusals (spec §3.5, §6.1, ARCHITECTURE.md §2.1)', () => {
  async function refused(headers: Record<string, string>, reason: string, status = 403, s = setup()) {
    const res = await call(s.api, headers);
    expect(res.status).toBe(status);
    expect(s.records).toEqual([expect.objectContaining({ message: 'refused', status, reason, tenantId: '-' })]);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(0);
    expect(dynamo.commandCalls(UpdateItemCommand)).toHaveLength(0);
    return res;
  }

  test('§10 step 7: a payload edited to name b, with a\'s signature, is refused with 403', async () => {
    const [h, , sig] = (await forA()).split('.');
    const claims = { tenant_id: TENANT_B, client_id: CLIENT, token_use: 'access', sub: 'u', iss: ISSUER };
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await refused({ 'x-tenant-token': `${h}.${forged}.${sig}`, 'x-tenant-route': TENANT_B.toLowerCase() }, 'invalid_token');
  });

  test('a token signed by another key, an unknown kid, another issuer or an unsigned token is refused with 403', async () => {
    await refused({ 'x-tenant-token': await forA({}, { key: otherKey }), 'x-tenant-route': TENANT_A }, 'invalid_token');
    await refused({ 'x-tenant-token': await forA({}, { header: { kid: 'nope' } }), 'x-tenant-route': TENANT_A }, 'invalid_token');
    await refused({ 'x-tenant-token': await forA({}, { issuer: 'https://evil.example.com' }), 'x-tenant-route': TENANT_A }, 'invalid_token');
    const [, payload] = (await forA()).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    await refused({ 'x-tenant-token': none, 'x-tenant-route': TENANT_A }, 'invalid_token');
    await refused({ 'x-tenant-token': 'not-a-jwt', 'x-tenant-route': TENANT_A }, 'invalid_token');
    await refused({ 'x-tenant-token': 'a'.repeat(8193), 'x-tenant-route': TENANT_A }, 'invalid_token');
  });

  test('no x-tenant-token is refused with 403', async () => {
    await refused({ 'x-tenant-route': TENANT_A }, 'missing_token');
  });

  test('an expired but authentic token gets 401 with WWW-Authenticate: Bearer', async () => {
    const res = await refused({ 'x-tenant-token': await forA({}, { expiresIn: -120 }), 'x-tenant-route': TENANT_A }, 'expired_token', 401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  test('a client outside the allowlist is refused; an aud in the allowlist is accepted when there is no client_id', async () => {
    await refused({ 'x-tenant-token': await forA({ client_id: 'other' }), 'x-tenant-route': TENANT_A }, 'wrong_client');
    const { api } = setup();
    const ok = await call(api, { 'x-tenant-token': await forA({ client_id: undefined, aud: ['api', CLIENT] }), 'x-tenant-route': TENANT_A });
    expect(ok.status).toBe(200);
  });

  test('an ID token is refused; typ at+jwt marks an access token when token_use is absent', async () => {
    await refused({ 'x-tenant-token': await forA({ token_use: 'id' }), 'x-tenant-route': TENANT_A }, 'not_access_token');
    await refused({ 'x-tenant-token': await forA({ token_use: undefined }), 'x-tenant-route': TENANT_A }, 'not_access_token');
    const { api } = setup();
    const ok = await call(api, { 'x-tenant-token': await forA({ token_use: undefined }, { header: { typ: 'at+jwt' } }), 'x-tenant-route': TENANT_A });
    expect(ok.status).toBe(200);
  });

  test('a token without exp is refused with 403 (ARCHITECTURE.md §2.1: exp is verified)', async () => {
    const noExp = await new SignJWT({ client_id: CLIENT, token_use: 'access', sub: 'user-1', tenant_id: TENANT_A })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .sign(privateKey);
    await refused({ 'x-tenant-token': noExp, 'x-tenant-route': TENANT_A }, 'invalid_token');
  });

  test('an unexpected verifier error answers 503 verify_failed with its class name only', async () => {
    const verifier = { verify: async () => Promise.reject(new RangeError('secret detail')) } as unknown as TokenVerifier;
    const s = setup({ verifier });
    const res = await call(s.api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(503);
    expect(s.records).toEqual([expect.objectContaining({ reason: 'verify_failed', error: 'RangeError', tenantId: '-' })]);
    expect(JSON.stringify(s.records)).not.toContain('secret detail');
  });

  test('a token without sub is refused', async () => {
    await refused({ 'x-tenant-token': await forA({ sub: '' }), 'x-tenant-route': TENANT_A }, 'no_subject');
  });

  test('a token with the multi-tenant claim is refused, even with a tenant_id (§3.5)', async () => {
    await refused({ 'x-tenant-token': await forA({ tenants: [TENANT_A, TENANT_B] }), 'x-tenant-route': TENANT_A }, 'multi_tenant_token');
  });

  test('a token with no tenant claim, a non-string claim or a claim that is not a route id is refused (§4.1)', async () => {
    await refused({ 'x-tenant-token': await token({}), 'x-tenant-route': TENANT_A }, 'no_tenant');
    await refused({ 'x-tenant-token': await token({ tenant_id: 7 }), 'x-tenant-route': TENANT_A }, 'bad_tenant_id');
    await refused({ 'x-tenant-token': await token({ tenant_id: '../B' }), 'x-tenant-route': TENANT_A }, 'bad_tenant_id');
  });

  test('no log line carries the token', async () => {
    const s = setup();
    const t = await forA();
    await call(s.api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_B });
    await call(s.api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A });
    await call(s.api, { 'x-tenant-token': `${t}x`, 'x-tenant-route': TENANT_A });
    const logged = JSON.stringify(s.records);
    for (const part of t.split('.')) {
      expect(logged).not.toContain(part);
    }
  });
});

describe('demo cell API: route hint (spec §3.5, ADR-0005, §10 step 8)', () => {
  test('a verified tenant that differs from x-tenant-route is refused with 403 and logged with both ids', async () => {
    const { api, records } = setup();
    const res = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_B.toLowerCase() });
    expect(res.status).toBe(403);
    expect(records).toEqual([
      expect.objectContaining({
        message: 'refused',
        reason: 'route_mismatch',
        tenantId: TENANT_A,
        routeTenantId: TENANT_B.toLowerCase(),
        cellId: CELL,
      }),
    ]);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(0);
  });

  test('a missing hint is refused, and a hint that is not a route id is logged as -', async () => {
    const { api, records } = setup();
    expect((await call(api, { 'x-tenant-token': await forA() })).status).toBe(403);
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': 'a b\n' })).status).toBe(403);
    expect(records.map((r) => [r.reason, r.routeTenantId])).toEqual([
      ['route_mismatch', '-'],
      ['route_mismatch', '-'],
    ]);
  });

  test('the comparison is case-insensitive', async () => {
    const { api } = setup();
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A })).status).toBe(200);
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A.toLowerCase() })).status).toBe(200);
  });
});

describe('demo cell API: hosts check (spec §3.5, §6.1)', () => {
  test('a validly signed token for a tenant this cell does not host is refused with 403 and logged with both ids', async () => {
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [] });
    const { api, records } = setup();
    const res = await call(api, { 'x-tenant-token': await token({ tenant_id: TENANT_B }), 'x-tenant-route': TENANT_B.toLowerCase() });
    expect(res.status).toBe(403);
    expect(records).toEqual([expect.objectContaining({ reason: 'not_hosted', tenantId: TENANT_B, routeTenantId: TENANT_B.toLowerCase() })]);
    expect(ssm.commandCalls(GetParametersByPathCommand)[0].args[0].input.Path).toBe(`/application-plane/tenants/${TENANT_B}/${APP}`);
  });

  test('follows an empty page with a NextToken before deciding', async () => {
    ssm
      .on(GetParametersByPathCommand)
      .resolvesOnce({ Parameters: [], NextToken: 'n1' })
      .resolvesOnce({ Parameters: [{ Name: 'p' }] });
    const { api } = setup();
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A })).status).toBe(200);
    expect(ssm.commandCalls(GetParametersByPathCommand)[1].args[0].input.NextToken).toBe('n1');
  });

  test('an SSM error fails closed with 503 and is not cached', async () => {
    ssm
      .on(GetParametersByPathCommand)
      .rejectsOnce(Object.assign(new Error('boom'), { name: 'ThrottlingException' }))
      .resolves({ Parameters: [{ Name: 'p' }] });
    const { api, records } = setup();
    const t = await forA();
    const res = await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(503);
    expect(records[0]).toEqual(expect.objectContaining({ reason: 'hosts_check_failed', error: 'ThrottlingException', tenantId: TENANT_A }));
    expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A })).status).toBe(200);
  });

  test('caches the answer per tenant, so a burst makes one SSM call', async () => {
    const { api } = setup();
    const t = await forA();
    for (let i = 0; i < 3; i++) {
      expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A })).status).toBe(200);
    }
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
  });
});

describe('demo cell API: per-tenant rate at the origin (spec §3.6 tenantRequestsPer5Min, ADR-0009)', () => {
  test('counts the verified tenant in a 5-minute window keyed PK=TENANT#<id>, SK=WINDOW#<n>, with a TTL', async () => {
    const { api } = setup({ limit: 5 });
    await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    const input = dynamo.commandCalls(UpdateItemCommand)[0].args[0].input;
    const windowIndex = Math.floor(NOW / 1000 / 300);
    expect(input.Key).toEqual({ PK: { S: `TENANT#${TENANT_A}` }, SK: { S: `WINDOW#${windowIndex}` } });
    expect(windowKey(TENANT_A, NOW)).toEqual({ PK: `TENANT#${TENANT_A}`, SK: `WINDOW#${windowIndex}` });
    expect(input.ConditionExpression).toBe('attribute_not_exists(requests) OR requests < :max');
    expect(input.ExpressionAttributeValues?.[':max']).toEqual({ N: '5' });
    expect(input.ExpressionAttributeValues?.[':ttl']).toEqual({ N: String((windowIndex + 2) * 300) });
  });

  test('over the limit is 429 with Retry-After to the end of the window, before the hosts check', async () => {
    dynamo.on(UpdateItemCommand).rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
    const { api, records } = setup({ limit: 5 });
    const res = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('240');
    expect(records).toEqual([expect.objectContaining({ reason: 'rate_limited', tenantId: TENANT_A })]);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(0);
  });

  test('a DynamoDB error fails open: the request is served and the error is logged', async () => {
    dynamo.on(UpdateItemCommand).rejects(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    const { api, records, failOpen } = setup({ limit: 5 });
    const res = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(200);
    expect(failOpen).toEqual([TENANT_A]);
    expect(records).toEqual([expect.objectContaining({ message: 'served', status: 200 })]);
  });

  test('a limit of 0 makes no DynamoDB call (host mode, where WAF limits each host)', async () => {
    const { api } = setup({ limit: 0 });
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A })).status).toBe(200);
    expect(dynamo.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  test('a refused token or hint is not counted', async () => {
    const { api } = setup({ limit: 5 });
    await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_B });
    await call(api, { 'x-tenant-token': 'x', 'x-tenant-route': TENANT_A });
    expect(dynamo.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});

describe('demo cell API: the issuer JWKS (spec §3.5)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('fetches the JWKS from the configured URL once and caches the keys', async () => {
    const fetchMock = jest.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(JWKS_URL);
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const verifier = new TokenVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, allowedClientIds: [CLIENT], tenantClaim: 'tenant_id' });
    const { api } = setup({ verifier });
    const t = await forA();
    expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A })).status).toBe(200);
    expect((await call(api, { 'x-tenant-token': t, 'x-tenant-route': TENANT_A })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an unreachable JWKS gets 503, not 403, and nothing is counted', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const verifier = new TokenVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, allowedClientIds: [CLIENT], tenantClaim: 'tenant_id' });
    const { api, records } = setup({ verifier });
    const res = await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A });
    expect(res.status).toBe(503);
    expect(records[0]).toEqual(expect.objectContaining({ reason: 'issuer_unavailable', tenantId: '-' }));
    expect(dynamo.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  test('a JWKS answer that is not 200 gets 503', async () => {
    globalThis.fetch = jest.fn(async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const verifier = new TokenVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, allowedClientIds: [CLIENT], tenantClaim: 'tenant_id' });
    const { api } = setup({ verifier });
    expect((await call(api, { 'x-tenant-token': await forA(), 'x-tenant-route': TENANT_A })).status).toBe(503);
  });

  test('the verifier needs at least one client id', () => {
    const options = { issuer: ISSUER, jwksUrl: JWKS_URL, allowedClientIds: [], tenantClaim: 'tenant_id' };
    expect(() => new TokenVerifier(options)).toThrow(/allowedClientIds/);
  });
});
