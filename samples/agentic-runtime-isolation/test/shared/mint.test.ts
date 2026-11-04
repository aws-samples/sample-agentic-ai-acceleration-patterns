// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { MAX_SCOPE_BYTES } from '../../src/shared/grant';
import { decodeJws, derToJose, verifyJws } from '../../src/shared/jws';
import {
  AGENT_AUDIENCE_PREFIX,
  MAX_TOKEN_BYTES,
  MintConfig,
  MintInput,
  mintCacheKey,
  qualifiedSubject,
  TokenMinter,
  toolsGatewayAudience,
  toolsGatewaysOf,
  TokenTooLargeError,
  TRANSACTION_TOKEN_TYPE,
  transactionClaims,
} from '../../src/shared/mint';
import { localRsaKey } from '../jws-helpers';

/** The transaction-token mint (spec §6.2.2, P-14, ADR-0031, ADR-0036, ADR-0037, ADR-0040). */
const INGRESS_ROLE = 'arn:aws:iam::111122223333:role/IngressRole';
const config: MintConfig = {
  issuer: 'https://example.execute-api.eu-central-1.amazonaws.com/prod',
  keyId: 'key-1',
  algorithm: 'RS256',
  ttlSeconds: 300,
  reuseMarginSeconds: 180,
  ingressRoleArn: INGRESS_ROLE,
};
const input: MintInput = {
  tenantId: 't-a',
  sub: 'user-1',
  agent: 'default',
  scope: 'crm/* default/chat',
  gateways: ['default'],
  versions: { tenant: 1, agent: 1 },
};

describe('transactionClaims', () => {
  it('names one tenant, one user and one agent, with the qualified sub, the user claim, both audiences and act', () => {
    expect(transactionClaims(input, config, 1000, { txn: 'txn-1', jti: 'jti-1' })).toEqual({
      iss: config.issuer,
      sub: 't-a#user-1',
      user: 'user-1',
      tenant_id: 't-a',
      agent: 'default',
      scope: 'crm/* default/chat',
      aud: [`${AGENT_AUDIENCE_PREFIX}default`, toolsGatewayAudience('default')],
      act: { sub: INGRESS_ROLE },
      txn: 'txn-1',
      iat: 1000,
      exp: 1300,
      jti: 'jti-1',
    });
    expect(qualifiedSubject('t-b', 'user-1')).toBe('t-b#user-1');
  });

  it('aud lists tools-gateway:<name> once per gateway, sorted; no granted tools means the agent alone (ADR-0041)', () => {
    const several = transactionClaims({ ...input, gateways: ['finance', 'default', 'finance'] }, config, 1000, { txn: 't', jti: 'j' });
    expect(several.aud).toEqual(['agent:default', 'tools-gateway:default', 'tools-gateway:finance']);
    expect(transactionClaims({ ...input, scope: 'default/chat', gateways: [] }, config, 1000, { txn: 't', jti: 'j' }).aud).toEqual(['agent:default']);
    expect(toolsGatewaysOf(several.aud)).toEqual(['default', 'finance']);
    expect(toolsGatewaysOf(['agent:x', 'tools-gateway', 'tools-gateway:BAD', 42, 'tools-gateway:ok'])).toEqual(['ok']);
  });
});

describe('mintCacheKey', () => {
  it('changes with every version, the tenant, the user, the agent and the scope', () => {
    const base = mintCacheKey(input);
    expect(mintCacheKey({ ...input })).toBe(base);
    for (const other of [
      { ...input, versions: { tenant: 2, agent: 1 } },
      { ...input, versions: { tenant: 1, agent: 2 } },
      { ...input, versions: { tenant: 1, agent: 1, plan: 3 } },
      { ...input, tenantId: 't-b' },
      { ...input, sub: 'user-2' },
      { ...input, agent: 'billing' },
      { ...input, scope: 'default/chat' },
      { ...input, gateways: ['default', 'finance'] },
    ]) {
      expect(mintCacheKey(other)).not.toBe(base);
    }
  });
});

describe('TokenMinter', () => {
  it('signs a compact JWS with typ txn+jwt and the kid, verifiable with the public key only', async () => {
    const key = localRsaKey();
    const minter = new TokenMinter(config, { signer: key.signer, now: () => 1_000_000, txnId: () => 'txn-1', jti: () => 'jti-1' });
    const minted = await minter.mint(input);
    expect(minted).toMatchObject({ txn: 'txn-1', exp: 1300, mint: 'miss' });
    const decoded = verifyJws(minted.token, key.publicKey, ['RS256']);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: TRANSACTION_TOKEN_TYPE, kid: 'key-1' });
    expect(decoded.payload.sub).toBe('t-a#user-1');
    expect(key.calls).toHaveLength(1);
    expect(key.calls[0]).toHaveLength(32);
  });

  it('reuses a cached token while more than the reuse margin is left, then mints again', async () => {
    const key = localRsaKey();
    let now = 1_000_000;
    const minter = new TokenMinter(config, { signer: key.signer, now: () => now });
    const first = await minter.mint(input);
    now += 100_000; // 100 s later: 200 s left > 180 s margin
    const second = await minter.mint(input);
    expect(second.mint).toBe('hit');
    expect(second.token).toBe(first.token);
    now += 30_000; // 170 s left: inside the margin
    const third = await minter.mint(input);
    expect(third.mint).toBe('miss');
    expect(third.token).not.toBe(first.token);
    expect(key.calls).toHaveLength(2);
  });

  it('a version bump misses the cache (a write to the tenant or a cut takes effect on the next request)', async () => {
    const key = localRsaKey();
    const minter = new TokenMinter(config, { signer: key.signer, now: () => 1_000_000 });
    await minter.mint(input);
    expect((await minter.mint({ ...input, versions: { tenant: 2, agent: 1 } })).mint).toBe('miss');
    expect(key.calls).toHaveLength(2);
  });

  it('concurrent mints of one key share one KMS call', async () => {
    const key = localRsaKey();
    const minter = new TokenMinter(config, { signer: key.signer, now: () => 1_000_000 });
    const [a, b] = await Promise.all([minter.mint(input), minter.mint(input)]);
    expect(a.token).toBe(b.token);
    expect(key.calls).toHaveLength(1);
  });

  it('the cache is bounded and evicts the least recently used entry', async () => {
    const key = localRsaKey();
    const minter = new TokenMinter({ ...config, cacheMaxEntries: 2 }, { signer: key.signer, now: () => 1_000_000 });
    await minter.mint({ ...input, sub: 'u1' });
    await minter.mint({ ...input, sub: 'u2' });
    await minter.mint({ ...input, sub: 'u1' }); // u1 is now the most recent
    await minter.mint({ ...input, sub: 'u3' }); // evicts u2
    expect(minter.size).toBe(2);
    expect((await minter.mint({ ...input, sub: 'u1' })).mint).toBe('hit');
    expect((await minter.mint({ ...input, sub: 'u2' })).mint).toBe('miss');
  });

  it('refuses a ttl outside 120 to 900 seconds (the Gateway refuses a token with 60 s or less left)', () => {
    const { signer } = localRsaKey();
    for (const ttlSeconds of [60, 119, 901, 120.5]) {
      expect(() => new TokenMinter({ ...config, ttlSeconds }, { signer })).toThrow(/ttlSeconds must be an integer from 120 to 900/);
    }
  });

  it('defaults to a 128-bit base64url txn and a UUID jti', async () => {
    const { signer } = localRsaKey();
    const minted = await new TokenMinter(config, { signer }).mint(input);
    expect(Buffer.from(minted.txn, 'base64url')).toHaveLength(16);
    expect(decodeJws(minted.token).payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('TokenMinter token bound (ADR-0045, spike V-17)', () => {
  // Long but valid claims: a 64-character tenant id, a 32-character agent,
  // four 32-character tools gateways, a UUID sub and kid, a CDK-length role
  // ARN, an execute-api issuer. RS256 with a 2048-bit key (what KMS signs
  // with), so the signature is 342 characters; ES256 would be 86.
  const longConfig: MintConfig = {
    ...config,
    issuer: 'https://abcdefghij.execute-api.eu-central-1.amazonaws.com/prod',
    keyId: '1234abcd-12ab-34cd-56ef-1234567890ab',
    ingressRoleArn: 'arn:aws:iam::111122223333:role/RuntimeIsolationDemo-SharedIngressIngressRoleABCDEF-ABCDEFGHIJKL',
  };
  const longInput = (scope: string): MintInput => ({
    tenantId: `t-${'a'.repeat(62)}`,
    sub: '0123abcd-4567-89ef-0123-456789abcdef',
    agent: 'a'.repeat(32),
    scope,
    gateways: Array.from({ length: 4 }, (_, i) => `${'g'.repeat(31)}${i}`),
    versions: { tenant: 1, agent: 1 },
  });
  const fixed = { now: () => 1_000_000_000, txnId: () => 'A'.repeat(22), jti: () => '0123abcd-4567-89ef-0123-456789abcdef' };
  const scopeOf = (bytes: number): string => 'x'.repeat(bytes);
  let written: string[];
  beforeEach(() => {
    written = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('measures the overhead: token = 4/3 x (scope + other claims) + header + signature', async () => {
    const { signer } = localRsaKey();
    const minter = new TokenMinter(longConfig, { signer, ...fixed });
    const empty = (await minter.mint(longInput(''))).token.length;
    const atBound = (await minter.mint(longInput(scopeOf(MAX_SCOPE_BYTES)))).token.length;
    // Measured 2026-11-04: 1,542 characters with an empty scope, 9,734 at 6,144 (506 under the cap).
    expect(empty).toBe(1542);
    expect(atBound).toBe(9734);
    expect(atBound - empty).toBe(Math.ceil((MAX_SCOPE_BYTES * 4) / 3));
    // A scope at the bound leaves at least 400 bytes under the Runtime cap.
    expect(MAX_TOKEN_BYTES).toBe(10240);
    expect(MAX_TOKEN_BYTES - atBound).toBeGreaterThanOrEqual(400);
  });

  it('the old 8,192-byte scope bound would have produced a token over the Runtime cap', async () => {
    const { signer } = localRsaKey();
    const minter = new TokenMinter(config, { signer, ...fixed });
    // Even with the short test claims (one gateway, short ids).
    const token = (await minter.mint({ ...input, scope: scopeOf(8192) }).catch((e: unknown) => e)) as TokenTooLargeError;
    expect(token).toBeInstanceOf(TokenTooLargeError);
    expect(token.encodedBytes).toBeGreaterThan(MAX_TOKEN_BYTES);
  });

  it('refuses a token over MAX_TOKEN_BYTES after signing even when the scope is under its bound, and caches nothing', async () => {
    const key = localRsaKey();
    const huge: MintConfig = { ...longConfig, issuer: `https://example.com/${'i'.repeat(400)}` };
    const minter = new TokenMinter(huge, { signer: key.signer, ...fixed });
    const scope = scopeOf(MAX_SCOPE_BYTES);
    const big = { ...longInput(scope), sub: 's'.repeat(200) };
    await expect(minter.mint(big)).rejects.toBeInstanceOf(TokenTooLargeError);
    await expect(minter.mint(big)).rejects.toMatchObject({ encodedBytes: expect.any(Number) });
    expect(minter.size).toBe(0);
    // Each attempt cost one Sign: the check measures the signed token.
    expect(key.calls).toHaveLength(2);
    // The log line names the length and the bound, never the token.
    const line = JSON.parse(written[0]) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'WARN', message: 'transaction token over the runtime header bound', limitBytes: 10240, scopeBytes: MAX_SCOPE_BYTES });
    expect(line.encodedBytes).toBeGreaterThan(MAX_TOKEN_BYTES);
    expect(written.join('')).not.toContain('eyJ');
  });

  it('a token of exactly MAX_TOKEN_BYTES is served', async () => {
    const { signer } = localRsaKey();
    const minter = new TokenMinter(longConfig, { signer, ...fixed });
    const atBound = (await minter.mint(longInput(scopeOf(MAX_SCOPE_BYTES)))).token.length;
    // Every 3 scope bytes add 4 characters: grow to exactly 10,240 if the arithmetic allows, else just under.
    const extra = Math.floor(((MAX_TOKEN_BYTES - atBound) * 3) / 4);
    const minted = await minter.mint(longInput(scopeOf(MAX_SCOPE_BYTES + extra)));
    expect(minted.token.length).toBeLessThanOrEqual(MAX_TOKEN_BYTES);
    expect(minted.token.length).toBeGreaterThan(MAX_TOKEN_BYTES - 4);
  });
});

describe('derToJose (ES256)', () => {
  it('turns a DER ECDSA signature into the 64-byte r || s JOSE form', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (let i = 0; i < 20; i++) {
      const message = Buffer.from(`message ${i}`);
      const der = cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
      const jose = derToJose(der);
      expect(jose).toHaveLength(64);
      expect(cryptoVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(true);
    }
  });

  it('refuses anything that is not a DER sequence of two integers', () => {
    expect(() => derToJose(Buffer.from([0x31, 0x00]))).toThrow(/not a DER sequence/);
    expect(() => derToJose(Buffer.from([0x30, 0x04, 0x03, 0x01, 0x00, 0x00]))).toThrow(/expected an INTEGER/);
  });
});
