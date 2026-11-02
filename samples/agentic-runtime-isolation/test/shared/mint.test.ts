// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { decodeJws, derToJose, verifyJws } from '../../src/shared/jws';
import {
  AGENT_AUDIENCE_PREFIX,
  MintConfig,
  MintInput,
  mintCacheKey,
  qualifiedSubject,
  TokenMinter,
  TOOLS_GATEWAY_AUDIENCE,
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
      aud: [`${AGENT_AUDIENCE_PREFIX}default`, TOOLS_GATEWAY_AUDIENCE],
      act: { sub: INGRESS_ROLE },
      txn: 'txn-1',
      iat: 1000,
      exp: 1300,
      jti: 'jti-1',
    });
    expect(qualifiedSubject('t-b', 'user-1')).toBe('t-b#user-1');
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

  it('refuses a ttl outside 60 to 900 seconds', () => {
    const { signer } = localRsaKey();
    for (const ttlSeconds of [59, 901, 120.5]) {
      expect(() => new TokenMinter({ ...config, ttlSeconds }, { signer })).toThrow(/ttlSeconds must be an integer from 60 to 900/);
    }
  });

  it('defaults to a 128-bit base64url txn and a UUID jti', async () => {
    const { signer } = localRsaKey();
    const minted = await new TokenMinter(config, { signer }).mint(input);
    expect(Buffer.from(minted.txn, 'base64url')).toHaveLength(16);
    expect(decodeJws(minted.token).payload.jti).toMatch(/^[0-9a-f-]{36}$/);
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
