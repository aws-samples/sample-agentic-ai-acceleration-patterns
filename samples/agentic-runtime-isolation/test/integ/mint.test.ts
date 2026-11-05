// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { INTEG_MINT_ENV, mint } from './mint.function';
import { decodeJws, verifyJws } from '../../src/shared/jws';
import { CONTEXT_TYPE } from '../../src/tools/context';
import { localRsaKey } from '../jws-helpers';

/** The test-only mint of the integration stacks (spec §8). */
const key = localRsaKey();
const NOW = 1_800_000_000_000;
const base = { tenantId: 'tenant-a', sub: 'u1', agent: 'default', scope: 'crm/* default/chat', gateways: ['default'] };

beforeAll(() => {
  process.env[INTEG_MINT_ENV.ISSUER] = 'https://issuer.example.com/prod';
  process.env[INTEG_MINT_ENV.KEY_ID] = 'key-1';
  process.env[INTEG_MINT_ENV.INGRESS_ROLE_ARN] = 'arn:aws:iam::111122223333:role/Ingress';
});

describe('integ mint', () => {
  it('mints the ingress shape: typ txn+jwt, kid, qualified sub, aud, act', async () => {
    const out = await mint(base, key.signer, NOW);
    const decoded = verifyJws(out.token!, key.publicKey, ['RS256']);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'txn+jwt', kid: 'key-1' });
    expect(decoded.payload).toMatchObject({ sub: 'tenant-a#u1', aud: ['agent:default', 'tools-gateway:default'], act: { sub: 'arn:aws:iam::111122223333:role/Ingress' } });
    expect(out.exp).toBe(NOW / 1000 + 300);
  });

  it('removes a claim set to null, overrides others, and sets typ', async () => {
    const out = await mint({ ...base, claims: { act: null, aud: ['agent:default'] }, typ: 'JWT' }, key.signer, NOW);
    const decoded = decodeJws(out.token!);
    expect(decoded.payload.act).toBeUndefined();
    expect(decoded.payload.aud).toEqual(['agent:default']);
    expect(decoded.header.typ).toBe('JWT');
  });

  it('tamperTenantId leaves the signature of the original claims', async () => {
    const out = await mint({ ...base, tamperTenantId: 'tenant-b' }, key.signer, NOW);
    expect(decodeJws(out.token!).payload.tenant_id).toBe('tenant-b');
    expect(() => verifyJws(out.token!, key.publicKey, ['RS256'])).toThrow();
  });

  it('forgeContext signs a context with this key, typ ri-ctx+jwt', async () => {
    const out = await mint({ ...base, forgeContext: { tenantId: 'tenant-b', tool: 'crm/update_case' } }, key.signer, NOW);
    expect(out.token).toBeUndefined();
    const decoded = verifyJws(out.context!, key.publicKey, ['RS256']);
    expect(decoded.header.typ).toBe(CONTEXT_TYPE);
    expect(decoded.payload).toMatchObject({ tenant_id: 'tenant-b', tool: 'crm/update_case' });
  });
});
