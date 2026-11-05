// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token authoriser (M-1, M-5, spec §7.0): one 401 per refusal case, the
 * Allow on `/tenant/*` with `tenantId`, `sub`, `scope`, and the usage key
 * the factory computes too.
 */

import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { CLIENT_ID, DISCOVERY_URL, ISSUER, testIssuer, type TestIssuer } from './helpers';
import { captureStdout } from './runtime-helpers';
import { createAuthoriser, tenantRoutesArn } from '../src/authoriser/handler';
import { usageKeyValue } from '../src/authoriser/usage-key';

const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:111122223333:abc123defg/v1/POST/tenant/deliveries';
const STACK_ID = 'arn:aws:cloudformation:eu-central-1:111122223333:stack/TenantEncryptedIngestion/00000000-0000-4000-8000-00000000000f';

let issuer: TestIssuer;
beforeAll(async () => {
  issuer = await testIssuer();
});

function authoriser(tenantThrottle = false) {
  return createAuthoriser(
    { discoveryUrl: DISCOVERY_URL, allowedClientIds: [CLIENT_ID], tenantThrottle, stackId: tenantThrottle ? STACK_ID : undefined },
    { getKey: issuer.getKey, fetchDiscovery: issuer.fetchDiscovery },
  );
}

function event(token: string | undefined): APIGatewayTokenAuthorizerEvent {
  return { type: 'TOKEN', authorizationToken: token === undefined ? '' : `Bearer ${token}`, methodArn: METHOD_ARN };
}

describe('authoriser refusals (every one a 401)', () => {
  const cases: [string, () => Promise<string | undefined>][] = [
    ['no token', async () => undefined],
    ['a token signed by an unknown key', () => issuer.mintForeign()],
    ['another issuer', () => issuer.mint({ iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_OTHERPOOL' })],
    ['an expired token', () => issuer.mint({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ['a client outside the allowlist', () => issuer.mint({ client_id: 'otherclient000000000000000' })],
    ['an id token', () => issuer.mint({ token_use: 'id' })],
    ['no sub', () => issuer.mint({}, ['sub'])],
    ['a multi-tenant token', () => issuer.mint({ tenants: ['tenant-a', 'tenant-b'] })],
    ['no tenant_id', () => issuer.mint({}, ['tenant_id'])],
    ['a tenant_id that is not a string', () => issuer.mint({ tenant_id: 42 })],
    ['a tenant_id with a slash', () => issuer.mint({ tenant_id: 'tenant-a/evil' })],
    ['a tenant_id with a slash', () => issuer.mint({ tenant_id: 'tenant/a' })],
    ['a one-character tenant_id', () => issuer.mint({ tenant_id: 'a' })],
    ['a tenant_id of 36 characters', () => issuer.mint({ tenant_id: 'a'.repeat(36) })],
  ];
  it.each(cases)('refuses %s', async (_name, mint) => {
    const token = await mint();
    const { error, lines } = await captureStdout(() => authoriser()(event(token)));
    expect(error).toEqual(new Error('Unauthorized'));
    // The refusal is logged by reason, never with the token.
    expect(lines.join('')).not.toContain(token ?? 'no-token-at-all');
  });
});

describe('authoriser allow', () => {
  it('allows /tenant/* of this stage with tenantId, sub and scope, and no usage key by default', async () => {
    const result = await authoriser()(event(await issuer.mint()));
    expect(result.principalId).toBe('user-a1');
    expect(result.policyDocument.Statement).toEqual([
      { Effect: 'Allow', Action: 'execute-api:Invoke', Resource: 'arn:aws:execute-api:eu-central-1:111122223333:abc123defg/v1/*/tenant/*' },
    ]);
    expect(result.context).toEqual({ tenantId: 'tenant-a', sub: 'user-a1', scope: 'ingestion/deliver ingestion/read' });
    expect(result.usageIdentifierKey).toBeUndefined();
  });

  it('returns the usage key the factory computes with tenantThrottle (M-5)', async () => {
    const result = await authoriser(true)(event(await issuer.mint({ tenant_id: 'tenant-b' })));
    expect(result.usageIdentifierKey).toBe(usageKeyValue(STACK_ID, 'tenant-b'));
    expect(result.usageIdentifierKey).toMatch(/^tei-[0-9a-f]{40}$/);
    expect(result.usageIdentifierKey).toHaveLength(44);
  });

  it('builds the tenant routes ARN from any method ARN of the stage', () => {
    expect(tenantRoutesArn('arn:aws:execute-api:eu-central-1:111122223333:abc/v1/GET/tenant/deliveries/X')).toBe(
      'arn:aws:execute-api:eu-central-1:111122223333:abc/v1/*/tenant/*',
    );
  });

  it('keeps the issuer constant out of the context', async () => {
    const result = await authoriser()(event(await issuer.mint()));
    expect(JSON.stringify(result.context)).not.toContain(ISSUER);
  });
});

describe('usage key', () => {
  it('is deterministic per stack and tenant, and differs between them', () => {
    expect(usageKeyValue(STACK_ID, 'tenant-a')).toBe(usageKeyValue(STACK_ID, 'tenant-a'));
    expect(usageKeyValue(STACK_ID, 'tenant-a')).not.toBe(usageKeyValue(STACK_ID, 'tenant-b'));
    expect(usageKeyValue(`${STACK_ID}x`, 'tenant-a')).not.toBe(usageKeyValue(STACK_ID, 'tenant-a'));
  });
});
