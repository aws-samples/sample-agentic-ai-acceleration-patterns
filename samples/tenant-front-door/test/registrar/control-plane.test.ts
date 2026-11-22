// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CELL, CELL_ACCOUNT, DT, FakeControlPlane, secretsMock, TENANT } from './support';
import { ControlPlaneReader } from '../../src/registrar/control-plane';

function reader(cp: FakeControlPlane, now: () => number = () => 0): ControlPlaneReader {
  return new ControlPlaneReader({
    baseUrl: 'https://cp.example.com/prod',
    tokenUrl: 'https://auth.example.com/oauth2/token',
    clientId: 'registrarclient',
    secretArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:registrar-AbCdEf',
    secrets: new SecretsManagerClient({}),
    fetch: cp.fetch as unknown as typeof fetch,
    now,
  });
}

beforeEach(() => {
  secretsMock.reset();
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'client-secret-value' });
});

describe('ADR-0015: the client-credentials reader token', () => {
  test('is requested with HTTP Basic client authentication and grant_type=client_credentials', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    await reader(cp).getCell(CELL);
    const [url, init] = cp.fetch.mock.calls[0];
    expect(url).toBe('https://auth.example.com/oauth2/token');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('grant_type=client_credentials');
    const auth = (init?.headers as Record<string, string>).authorization;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('registrarclient:client-secret-value');
    expect(secretsMock.commandCalls(GetSecretValueCommand)[0].args[0].input.SecretId).toContain('secret:registrar');
  });

  test('is cached until shortly before it expires, then fetched again', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    let now = 0;
    const r = reader(cp, () => now);
    await r.getCell(CELL);
    await r.getCell(CELL);
    expect(cp.tokenCalls).toBe(1);
    now = 3600_000 - 61_000;
    await r.getCell(CELL);
    expect(cp.tokenCalls).toBe(1);
    now = 3600_000 - 59_000;
    await r.getCell(CELL);
    expect(cp.tokenCalls).toBe(2);
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  test('concurrent reads share one token request', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    const r = reader(cp);
    await Promise.all([r.getCell(CELL), r.getCell(CELL), r.getCell(CELL)]);
    expect(cp.tokenCalls).toBe(1);
  });

  test('a 401 drops the cached token and retries once with a new one', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    const r = reader(cp);
    await r.getCell(CELL);
    (cp as unknown as { token: string }).token = 'reader-token-2';
    // The fake now refuses the cached token with 401 and mints the new one.
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(cp.tokenCalls).toBe(2);
  });

  test.each([
    ['a token endpoint error', (cp: FakeControlPlane) => (cp.tokenStatus = 500)],
    ['a token without expires_in', (cp: FakeControlPlane) => (cp.tokenExpiresIn = 0)],
  ])('%s is a 503', async (_why, change) => {
    const cp = new FakeControlPlane();
    change(cp);
    await expect(reader(cp).getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });

  test('an unreadable secret is a 503', async () => {
    secretsMock.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
    await expect(reader(new FakeControlPlane()).getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });
});

describe('§3.4 step 2: control-plane reads', () => {
  test('GetDeployment gives the cell, the account, the status and createdAt as dt', async () => {
    const cp = new FakeControlPlane();
    cp.deployment(TENANT, { status: 'CREATING' });
    expect(await reader(cp).getDeployment(TENANT.toLowerCase(), 'demo-app')).toEqual({
      applicationId: 'demo-app',
      cellId: CELL,
      accountId: CELL_ACCOUNT,
      status: 'CREATING',
      dt: DT,
    });
    expect(cp.reads).toEqual([`/tenants/${TENANT}/deployments/demo-app`]);
  });

  test('a 404 with ResourceNotFoundError is a missing record', async () => {
    const r = reader(new FakeControlPlane());
    expect(await r.getCell(CELL)).toBeUndefined();
    expect(await r.getDeployment(TENANT, 'demo-app')).toBeUndefined();
    expect(await r.getTenant(TENANT)).toBeUndefined();
  });

  test.each([
    ['a status the control plane does not have', { status: 'GONE' }],
    ['an account that is not 12 digits', { status: 'ACTIVE', accountId: '12' }],
  ])('%s is a 503', async (_why, cell) => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, cell);
    await expect(reader(cp).getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });

  test.each([undefined, '', 'yesterday', 1795080000000, '2026-11-19T09:20:00+01:00'])('createdAt %p is a 503', async (createdAt) => {
    const cp = new FakeControlPlane();
    cp.deployment(TENANT, { status: 'CREATING', createdAt });
    await expect(reader(cp).getDeployment(TENANT, 'demo-app')).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });

  test('a network failure is a 503', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await r.getTenant(TENANT);
    cp.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(r.getTenant(TENANT)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });

  test('a body that is not JSON is a 503', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await r.getTenant(TENANT);
    cp.fetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(r.getTenant(TENANT)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
  });
});
