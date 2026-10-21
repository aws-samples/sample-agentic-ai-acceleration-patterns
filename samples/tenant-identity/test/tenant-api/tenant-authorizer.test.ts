// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createSign, generateKeyPairSync } from 'crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SCOPE_API_READ, SCOPE_TENANT_ADMIN } from '../../src/shared/constants';
import type { RegistryReader, TenantRecord } from '../../src/shared/registry';
import { authorize, stripBearer, type AuthorizeDeps, type TokenVerifier } from '../../src/tenant-api/tenant-authorizer';

/**
 * Unit tests for the tenant authoriser core (ADR-0007, spec §10
 * unit-assertion paragraph): refuses an ID token, a token from another pool
 * or app client, a token with `tenants`, a token without `tenant-admin/users`,
 * a tenant that is not ACTIVE, and the pool-per-tenant mismatch cases;
 * accepts a correct one.
 */

const TENANT_A = '01HZX9ABCDEFGHJKMNPQRSTVWX';
const TENANT_B = '01HZX9ABCDEFGHJKMNPQRSTVWY';
const POOL_A = 'eu-central-1_AAAApoolA';
const POOL_B = 'eu-central-1_BBBBpoolB';
const CLIENT = 'appclient0000000000000';
const SUB = 'user-sub-0001';

function activeTenant(over: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: TENANT_A,
    name: 'Tenant A',
    status: 'ACTIVE',
    topology: 'shared-pool',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...over,
  };
}

/** A registry stub whose behaviour each test sets per method. */
function fakeRegistry(over: Partial<RegistryReader> = {}): RegistryReader {
  return {
    get: jest.fn().mockResolvedValue(activeTenant()),
    batchGet: jest.fn().mockResolvedValue([]),
    getByUserPoolId: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

/** A verifier whose verify() resolves to the given claims or throws. */
function verifierReturning(claims: Record<string, unknown>): () => TokenVerifier {
  return () => ({ verify: jest.fn().mockResolvedValue(claims) });
}

function verifierThrowing(): () => TokenVerifier {
  return () => ({ verify: jest.fn().mockRejectedValue(new Error('JwtInvalidSignatureError')) });
}

const goodClaims = {
  token_use: 'access',
  tenant_id: TENANT_A,
  scope: `${SCOPE_API_READ} ${SCOPE_TENANT_ADMIN}`,
  sub: SUB,
  client_id: CLIENT,
};

describe('stripBearer', () => {
  it('strips a case-insensitive Bearer prefix', () => {
    expect(stripBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(stripBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(stripBearer('BEARER   abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('refuses a missing or non-bearer header (ADR-0007)', () => {
    expect(stripBearer(undefined)).toBeUndefined();
    expect(stripBearer('')).toBeUndefined();
    expect(stripBearer('Basic abc')).toBeUndefined();
    expect(stripBearer('abc.def.ghi')).toBeUndefined();
  });
});

describe('authorize — shared pool (P-6, ADR-0007)', () => {
  const sharedPool = { userPoolId: POOL_A, appClientId: CLIENT };

  it('accepts a correct narrowed admin token and returns {tenantId, sub}', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning(goodClaims),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toEqual({ tenantId: TENANT_A, sub: SUB });
  });

  it('refuses an ID token (token_use id)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning({ ...goodClaims, token_use: 'id' }),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token from another pool/app client (verifier throws)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierThrowing(),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token with a `tenants` claim (un-narrowed topology 3)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning({ ...goodClaims, tenants: [TENANT_A] }),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token without tenant-admin/users scope (ADR-0015)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning({ ...goodClaims, scope: SCOPE_API_READ }),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a tenant_id that is not a ULID', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning({ ...goodClaims, tenant_id: 'not-a-ulid' }),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token whose tenant is DELETING (P-2)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry({ get: jest.fn().mockResolvedValue(activeTenant({ status: 'DELETING' })) }),
      verifierFor: verifierReturning(goodClaims),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token whose tenant is absent from the registry', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry({ get: jest.fn().mockResolvedValue(undefined) }),
      verifierFor: verifierReturning(goodClaims),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });

  it('refuses a token with no sub', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning({ ...goodClaims, sub: undefined }),
      sharedPool,
    };
    await expect(authorize('t.t.t', deps)).resolves.toBeUndefined();
  });
});

describe('authorize — pool-per-tenant (ADR-0007)', () => {
  // No sharedPool: the issuer picks the pool via the registry. The token is a
  // real unsigned-structure string so decomposeUnverifiedJwt can read `iss`.
  function tokenWithIssuer(poolId: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: `https://cognito-idp.eu-central-1.amazonaws.com/${poolId}` }),
    ).toString('base64url');
    return `${header}.${payload}.sig`;
  }

  it('accepts when the registry maps the issuing pool to the token tenant', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry({
        getByUserPoolId: jest.fn().mockResolvedValue(
          activeTenant({ tenantId: TENANT_A, topology: 'pool-per-tenant', userPoolId: POOL_A, appClientId: CLIENT }),
        ),
        get: jest.fn().mockResolvedValue(
          activeTenant({ tenantId: TENANT_A, topology: 'pool-per-tenant', userPoolId: POOL_A, appClientId: CLIENT }),
        ),
      }),
      verifierFor: verifierReturning(goodClaims),
    };
    await expect(authorize(tokenWithIssuer(POOL_A), deps)).resolves.toEqual({ tenantId: TENANT_A, sub: SUB });
  });

  it('refuses when the issuing pool is not in the registry', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry({ getByUserPoolId: jest.fn().mockResolvedValue(undefined) }),
      verifierFor: verifierReturning(goodClaims),
    };
    await expect(authorize(tokenWithIssuer(POOL_A), deps)).resolves.toBeUndefined();
  });

  it('refuses when the registry tenant for the pool != tenant_id', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry({
        getByUserPoolId: jest.fn().mockResolvedValue(
          activeTenant({ tenantId: TENANT_B, topology: 'pool-per-tenant', userPoolId: POOL_B, appClientId: CLIENT }),
        ),
      }),
      // token claims tenant_id = A, but the pool belongs to B.
      verifierFor: verifierReturning(goodClaims),
    };
    await expect(authorize(tokenWithIssuer(POOL_B), deps)).resolves.toBeUndefined();
  });

  it('refuses a malformed JWT (cannot read iss)', async () => {
    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: verifierReturning(goodClaims),
    };
    await expect(authorize('not-a-jwt', deps)).resolves.toBeUndefined();
  });
});

describe('authorize — real CognitoJwtVerifier end to end (ADR-0007)', () => {
  // Prove the signature path with a locally generated RSA key and JWKS, so a
  // tampered or wrongly signed token is refused by the real library, not a mock.
  const ISSUER_REGION = 'eu-central-1';

  function b64url(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
  }

  async function mintAndVerify(
    payloadExtra: Record<string, unknown>,
    tamper = false,
  ): Promise<ReturnType<typeof authorize> extends Promise<infer R> ? R : never> {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'test-key-1';
    // Export the public key as a JWK (n, e) and add the fields the JWKS needs.
    const pubJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const jwk = { kty: 'RSA', n: pubJwk.n, e: pubJwk.e, kid, alg: 'RS256', use: 'sig' };
    const issuer = `https://cognito-idp.${ISSUER_REGION}.amazonaws.com/${POOL_A}`;

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({
        token_use: 'access',
        client_id: CLIENT,
        scope: `${SCOPE_API_READ} ${SCOPE_TENANT_ADMIN}`,
        sub: SUB,
        tenant_id: TENANT_A,
        iss: issuer,
        iat: now,
        exp: now + 300,
        ...payloadExtra,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
    let token = `${signingInput}.${signature}`;

    if (tamper) {
      const parts = token.split('.');
      parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'BB' : 'AA');
      token = parts.join('.');
    }

    const verifier = CognitoJwtVerifier.create({ userPoolId: POOL_A, tokenUse: 'access', clientId: CLIENT });
    // Seed the JWKS so no network fetch is needed (the real signature check runs).
    verifier.cacheJwks({ keys: [jwk as never] });

    const deps: AuthorizeDeps = {
      registry: fakeRegistry(),
      verifierFor: () => verifier as unknown as TokenVerifier,
      sharedPool: { userPoolId: POOL_A, appClientId: CLIENT },
    };
    return authorize(token, deps);
  }

  it('accepts a correctly signed token', async () => {
    await expect(mintAndVerify({})).resolves.toEqual({ tenantId: TENANT_A, sub: SUB });
  });

  it('refuses a token whose signature was tampered with', async () => {
    await expect(mintAndVerify({}, true)).resolves.toBeUndefined();
  });
});
