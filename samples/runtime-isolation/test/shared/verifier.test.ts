// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { bearerToken, TokenError, TokenVerifier, USER_ADMIN_SCOPE } from '../../src/shared/verifier';
import { CLIENT_ID, DISCOVERY_URL, OTHER_CLIENT_ID, testIssuer, type TestIssuer } from '../helpers';

/** P-3 and spec §6.2: every check the ingress makes on a token, with its status (spec §5). */
describe('TokenVerifier', () => {
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await testIssuer();
  });

  const verifier = (options: Partial<ConstructorParameters<typeof TokenVerifier>[0]> = {}) =>
    new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], ...options },
      { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
    );

  const refusal = async (promise: Promise<unknown>): Promise<{ status: number; reason: string }> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof TokenError) {
        return { status: error.status, reason: error.reason };
      }
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('accepts a valid access token and returns the claims the ingress may act on', async () => {
    const claims = await verifier().verify(await issuer.mint());
    expect(claims.tenantId).toBe('tenant-a');
    expect(claims.sub).toBe('user-a1');
    expect(claims.clientId).toBe(CLIENT_ID);
    expect(claims.scopes).toEqual(['tenant-api/read', 'tenant-api/write', USER_ADMIN_SCOPE]);
    expect(claims.claims.tenant_id).toBe('tenant-a');
  });

  it('401 for a missing token', async () => {
    expect(await refusal(verifier().verify(undefined))).toEqual({ status: 401, reason: 'missing_token' });
    expect(await refusal(verifier().verify(''))).toEqual({ status: 401, reason: 'missing_token' });
  });

  it('401 for a token signed by an unknown key', async () => {
    expect(await refusal(verifier().verify(await issuer.mintForeign()))).toEqual({ status: 401, reason: 'invalid_token' });
  });

  it('401 for a tampered token', async () => {
    const token = await issuer.mint();
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.tenant_id = 'tenant-b';
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(await refusal(verifier().verify(tampered))).toEqual({ status: 401, reason: 'invalid_token' });
  });

  it('401 for an expired token', async () => {
    const token = await issuer.mint({ exp: Math.floor(Date.now() / 1000) - 120 });
    expect(await refusal(verifier().verify(token))).toEqual({ status: 401, reason: 'invalid_token' });
  });

  it('401 for another issuer', async () => {
    const token = await issuer.mint({ iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_OTHERPOOL0' });
    expect(await refusal(verifier().verify(token))).toEqual({ status: 401, reason: 'invalid_token' });
  });

  it('401 for another client', async () => {
    expect(await refusal(verifier().verify(await issuer.mint({ client_id: OTHER_CLIENT_ID })))).toEqual({ status: 401, reason: 'wrong_client' });
    expect(await refusal(verifier().verify(await issuer.mint({ client_id: undefined })))).toEqual({ status: 401, reason: 'wrong_client' });
  });

  it('accepts any of several allowed clients', async () => {
    const v = verifier({ allowedClientIds: [OTHER_CLIENT_ID, CLIENT_ID] });
    await expect(v.verify(await issuer.mint())).resolves.toBeDefined();
  });

  it('401 for an ID token (token_use is not access)', async () => {
    expect(await refusal(verifier().verify(await issuer.mint({ token_use: 'id' })))).toEqual({ status: 401, reason: 'not_access_token' });
  });

  it('403 for a token without tenant_id', async () => {
    expect(await refusal(verifier().verify(await issuer.mint({ tenant_id: undefined })))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(await refusal(verifier().verify(await issuer.mint({ tenant_id: '' })))).toEqual({ status: 403, reason: 'no_tenant' });
    expect(await refusal(verifier().verify(await issuer.mint({ tenant_id: ['tenant-a'] as any })))).toEqual({ status: 403, reason: 'no_tenant' });
  });

  it('403 for a token that still carries a tenants claim (not narrowed to one tenant)', async () => {
    expect(await refusal(verifier().verify(await issuer.mint({ tenants: ['tenant-a', 'tenant-b'] })))).toEqual({
      status: 403,
      reason: 'multi_tenant_token',
    });
  });

  describe('warm (ADR-0023)', () => {
    it('fetches the discovery document and reloads the JWKS, then resolves', async () => {
      const reload = jest.fn().mockResolvedValue(undefined);
      const fetchDiscovery = jest.fn(issuer.fetchDiscovery);
      const getKey = Object.assign(issuer.getKey, { reload });
      const v = new TokenVerifier({ discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] }, { getKey, fetchDiscovery });
      await expect(v.warm()).resolves.toBeUndefined();
      expect(fetchDiscovery).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      // The first verify reuses the fetched discovery document.
      await v.verify(await issuer.mint());
      expect(fetchDiscovery).toHaveBeenCalledTimes(1);
    });

    it('resolves on a failed discovery and leaves verify to retry', async () => {
      const fetchDiscovery = jest.fn().mockRejectedValueOnce(new Error('down')).mockImplementation(issuer.fetchDiscovery);
      const v = new TokenVerifier({ discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] }, { getKey: issuer.getKey, fetchDiscovery });
      await expect(v.warm()).resolves.toBeUndefined();
      await expect(v.verify(await issuer.mint())).resolves.toMatchObject({ clientId: CLIENT_ID });
      expect(fetchDiscovery).toHaveBeenCalledTimes(2);
    });
  });

  describe('requiredScopes (ADR-0005)', () => {
    it('requires every listed scope (AND)', async () => {
      const v = verifier({ requiredScopes: ['tenant-api/read', 'tenant-api/write'] });
      await expect(v.verify(await issuer.mint())).resolves.toBeDefined();
      expect(await refusal(v.verify(await issuer.mint({ scope: 'tenant-api/write' })))).toEqual({ status: 403, reason: 'scope_missing' });
      expect(await refusal(v.verify(await issuer.mint({ scope: undefined })))).toEqual({ status: 403, reason: 'scope_missing' });
    });
  });

  describe('requireNarrowedToken (ADR-0007)', () => {
    const v = () => verifier({ requireNarrowedToken: true, allowedScopes: ['tenant-api/read'] });

    it('refuses an un-narrowed token (carries user.admin and a scope outside the allowlist)', async () => {
      expect(await refusal(v().verify(await issuer.mint()))).toEqual({ status: 403, reason: 'not_narrowed' });
    });

    it('refuses a token with a scope outside allowedScopes', async () => {
      expect(await refusal(v().verify(await issuer.mint({ scope: 'tenant-api/read tenant-api/write' })))).toEqual({ status: 403, reason: 'not_narrowed' });
    });

    it('refuses the Cognito user.admin scope even when listed', async () => {
      const w = verifier({ requireNarrowedToken: true, allowedScopes: ['tenant-api/read', USER_ADMIN_SCOPE] });
      expect(await refusal(w.verify(await issuer.mint({ scope: `tenant-api/read ${USER_ADMIN_SCOPE}` })))).toEqual({ status: 403, reason: 'not_narrowed' });
    });

    it('accepts a token whose scopes are a subset of allowedScopes', async () => {
      await expect(v().verify(await issuer.mint({ scope: 'tenant-api/read' }))).resolves.toBeDefined();
    });

    it('requires allowedScopes at construction', () => {
      expect(() => verifier({ requireNarrowedToken: true })).toThrow(/allowedScopes/);
    });
  });

  it('refuses an empty allowedClientIds at construction', () => {
    expect(() => verifier({ allowedClientIds: [] })).toThrow(/allowedClientIds/);
  });

  it('fetches the discovery document once per instance and retries after a failure', async () => {
    let calls = 0;
    const flaky = new TokenVerifier(
      { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID] },
      {
        getKey: issuer.getKey,
        fetchDiscovery: async (url) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('network');
          }
          return issuer.fetchDiscovery(url);
        },
      },
    );
    await expect(flaky.verify(await issuer.mint())).rejects.toThrow('network');
    await expect(flaky.verify(await issuer.mint())).resolves.toBeDefined();
    await expect(flaky.verify(await issuer.mint())).resolves.toBeDefined();
    expect(calls).toBe(2);
  });
});

describe('bearerToken', () => {
  it('extracts the token from a Bearer header, case-insensitively', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('  Bearer   abc ')).toBe('abc');
  });

  it('returns undefined for anything else', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('abc.def.ghi')).toBeUndefined();
  });
});
