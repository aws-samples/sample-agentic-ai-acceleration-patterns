// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test helpers. A synthetic issuer for the unit tests: one RS256 key pair, a local JWKS the
 * verifier resolves against, and a token minter that signs any claim set.
 * Nothing here touches the network; every identifier is invented.
 */

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey, type KeyLike } from 'jose';
import type { IngressConfig } from '../src/shared/config';
import { type RegistryEntry, RegistryError } from '../src/shared/registry';
import type { RegistryResolver } from '../src/shared/request';
import type { Discovery } from '../src/shared/verifier';

export const ISSUER = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL00';
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const CLIENT_ID = 'testclient0000000000000000';
export const OTHER_CLIENT_ID = 'otherclient000000000000000';

export interface TestIssuer {
  readonly getKey: JWTVerifyGetKey;
  readonly fetchDiscovery: (url: string) => Promise<Discovery>;
  /** A valid access token for the given overrides (defaults: tenant-a, user-a1, the default backend's scope and billing/read). */
  mint(overrides?: JWTPayload & { exp?: number }, headerKid?: string): Promise<string>;
  /** A token signed by a key the JWKS does not know. */
  mintForeign(overrides?: JWTPayload): Promise<string>;
}

export const DEFAULT_CLAIMS: JWTPayload = {
  sub: 'user-a1',
  tenant_id: 'tenant-a',
  client_id: CLIENT_ID,
  token_use: 'access',
  scope: 'default/chat billing/read aws.cognito.signin.user.admin',
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

/** The registry prefix and the one backend the fixtures resolve (ADR-0024), with its one scope (ADR-0025). */
export const REGISTRY_PREFIX = '/application-plane/shared/agent-runtime/';
export const DEFAULT_BACKEND = 'default';
export const DEFAULT_SCOPE = 'default/chat';
export const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_test-abc123';
/** A second backend the fixtures add: two scopes of its own, any one admits (ADR-0025). */
export const BILLING_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_billing-1';
export const BILLING_SCOPES = ['billing/read', 'billing/invoke'];
/** A draining backend. */
export const OLD_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:111122223333:runtime/ri_old-1';
export const FIXTURE_ENTRIES: Record<string, RegistryEntry> = {
  billing: { runtimeArn: BILLING_RUNTIME_ARN, scopes: BILLING_SCOPES, status: 'active' },
  old: { runtimeArn: OLD_RUNTIME_ARN, scopes: ['old/chat'], status: 'draining' },
};

/** An ingress configuration with every module off; tests override what they need. */
export const baseConfig = (overrides: Partial<IngressConfig> = {}): IngressConfig => ({
  ingress: 'api-gateway',
  discoveryUrl: DISCOVERY_URL,
  allowedClientIds: [CLIENT_ID],
  delegation: { forwardUserToken: false, requireNarrowedToken: false },
  perTenantMetrics: false,
  registry: { prefix: REGISTRY_PREFIX, ttlSeconds: 60, defaultBackend: DEFAULT_BACKEND },
  ...overrides,
});

/**
 * A registry stub with no SSM behind it: `default` resolves to RUNTIME_ARN
 * with the one scope `default/chat`, plus whatever entries a test adds; any
 * other name is `unknown_backend`. `warmed` records the names `warm()` was
 * asked for.
 */
export const stubRegistry = (entries: Record<string, RegistryEntry> = {}) => {
  const table: Record<string, RegistryEntry> = { [DEFAULT_BACKEND]: { runtimeArn: RUNTIME_ARN, scopes: [DEFAULT_SCOPE], status: 'active' }, ...entries };
  const warmed: string[] = [];
  const registry: RegistryResolver = {
    resolve: async (backend: string) => {
      const entry = table[backend];
      if (entry === undefined) {
        throw new RegistryError('unknown_backend');
      }
      if (entry.status === 'draining') {
        throw new RegistryError('backend_draining');
      }
      return entry;
    },
    warm: async (backend: string | undefined) => {
      if (backend !== undefined) {
        warmed.push(backend);
      }
    },
  };
  return { registry, warmed };
};
