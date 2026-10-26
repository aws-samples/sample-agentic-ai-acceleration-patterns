// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test helpers. A synthetic issuer for the unit tests: one RS256 key pair, a local JWKS the
 * verifier resolves against, and a token minter that signs any claim set.
 * Nothing here touches the network; every identifier is invented.
 */

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey, type KeyLike } from 'jose';
import type { IngressConfig } from '../src/shared/config';
import type { Discovery } from '../src/shared/verifier';

export const ISSUER = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00';
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const CLIENT_ID = 'testclient0000000000000000';
export const OTHER_CLIENT_ID = 'otherclient000000000000000';

export interface TestIssuer {
  readonly getKey: JWTVerifyGetKey;
  readonly fetchDiscovery: (url: string) => Promise<Discovery>;
  /** A valid access token for the given overrides (defaults: tenant-a, user-a1, both scopes). */
  mint(overrides?: JWTPayload & { exp?: number }, headerKid?: string): Promise<string>;
  /** A token signed by a key the JWKS does not know. */
  mintForeign(overrides?: JWTPayload): Promise<string>;
}

export const DEFAULT_CLAIMS: JWTPayload = {
  sub: 'user-a1',
  tenant_id: 'tenant-a',
  client_id: CLIENT_ID,
  token_use: 'access',
  scope: 'tenant-api/read tenant-api/write aws.cognito.signin.user.admin',
};

export async function testIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const sign = async (key: KeyLike, overrides: JWTPayload = {}, kid = 'k1') => {
    const claims = { ...DEFAULT_CLAIMS, ...overrides };
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt();
    jwt = claims.iss === undefined ? jwt.setIssuer(ISSUER) : jwt;
    jwt = claims.exp === undefined ? jwt.setExpirationTime('5m') : jwt;
    return jwt.sign(key);
  };
  return {
    getKey,
    fetchDiscovery: async (url: string) => {
      if (url !== DISCOVERY_URL) {
        throw new Error('unexpected discovery url');
      }
      return { issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks.json` };
    },
    mint: (overrides, kid) => sign(privateKey, overrides, kid),
    mintForeign: (overrides) => sign(foreign.privateKey, overrides),
  };
}

/** An ingress configuration with every module off; tests override what they need. */
export const baseConfig = (overrides: Partial<IngressConfig> = {}): IngressConfig => ({
  ingress: 'api-gateway',
  discoveryUrl: DISCOVERY_URL,
  allowedClientIds: [CLIENT_ID],
  delegation: { forwardUserToken: false, requireNarrowedToken: false },
  ...overrides,
});
