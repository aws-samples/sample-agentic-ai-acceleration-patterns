// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CELL, CELL_ACCOUNT, DT, FakeControlPlane, secretsMock, TENANT } from './support';
import { ControlPlaneReader, READ_BUDGET_MS } from '../../src/registrar/control-plane';

const sleeps: number[] = [];

type Sleep = (ms: number) => Promise<void>;

const recordSleep: Sleep = async (ms) => void sleeps.push(ms);

function reader(cp: FakeControlPlane, now: () => number = () => 0, sleep: Sleep = recordSleep, random = () => 0.5): ControlPlaneReader {
  return new ControlPlaneReader({
    baseUrl: 'https://cp.example.com/prod',
    tokenUrl: 'https://auth.example.com/oauth2/token',
    clientId: 'registrarclient',
    secretArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:registrar-AbCdEf', // pragma: allowlist secret
    secrets: new SecretsManagerClient({}),
    fetch: cp.fetch as unknown as typeof fetch,
    now,
    sleep,
    random,
  });
}

beforeEach(() => {
  sleeps.length = 0;
  secretsMock.reset();
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'client-secret-value' }); // pragma: allowlist secret
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
    cp.fetch.mockRejectedValue(new Error('ECONNRESET'));
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

function timeout(): Error {
  return Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}

/** A warm reader: the secret and the token are cached, so the next failure is on the read itself. */
async function warm(cp: FakeControlPlane, r: ControlPlaneReader): Promise<void> {
  cp.cells.set(CELL, { status: 'ACTIVE' });
  await r.getCell(CELL);
  cp.reads.length = 0;
  cp.fetch.mockClear();
}

describe('§3.4 step 2: a read is tried once more', () => {
  test('a read that times out, then succeeds, is retried once after a jittered pause', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.fetch.mockRejectedValueOnce(timeout());
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(cp.reads).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  test.each([0, 1])('the pause is between 100 and 400 ms (random %p)', async (random) => {
    const cp = new FakeControlPlane();
    const r = reader(cp, () => 0, async (ms) => void sleeps.push(ms), () => random);
    await warm(cp, r);
    cp.fetch.mockRejectedValueOnce(timeout());
    await r.getCell(CELL);
    expect(sleeps).toEqual([random === 0 ? 100 : 400]);
  });

  test.each([500, 502, 503, 504])('a %p, then success, is retried once', async (code) => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.fetch.mockResolvedValueOnce(new Response('{}', { status: code }));
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(sleeps).toHaveLength(1);
  });

  test('a network failure, then success, is retried once', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
  });

  test('two failures are a 503, and the read is made twice, never three times', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.failWith = 503;
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(cp.reads).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  test('two timeouts are a 503', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.fetch.mockRejectedValue(timeout());
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(cp.fetch).toHaveBeenCalledTimes(2);
  });

  test('a 404 ResourceNotFoundError is a missing record and is not retried', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    expect(await r.getDeployment(TENANT, 'demo-app')).toBeUndefined();
    expect(cp.reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test.each([400, 404])('a %p without the error type is a 503 and is not retried', async (code) => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    cp.failWith = code;
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(cp.reads).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test('a 401 is refreshed once with no pause, and a second 401 is a 503 with no retry', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    (cp as unknown as { token: string }).token = 'reader-token-2';
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(sleeps).toEqual([]);
    cp.fetch.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(sleeps).toEqual([]);
  });

  test('a body that ends early is retried; a body that is not JSON is not', async () => {
    const cp = new FakeControlPlane();
    const r = reader(cp);
    await warm(cp, r);
    const broken = new Response('{}', { status: 200 });
    jest.spyOn(broken, 'json').mockRejectedValue(new TypeError('terminated'));
    cp.fetch.mockResolvedValueOnce(broken);
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    cp.fetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(sleeps).toHaveLength(1);
  });

  test('a token request that fails with a 5xx or times out, then succeeds, is retried', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    cp.tokenStatus = 503;
    const r = reader(cp, () => 0, async (ms) => {
      sleeps.push(ms);
      cp.tokenStatus = 200;
    });
    expect(await r.getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(cp.tokenCalls).toBe(2);
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);

    const cp2 = new FakeControlPlane();
    cp2.cells.set(CELL, { status: 'ACTIVE' });
    cp2.fetch.mockRejectedValueOnce(timeout());
    expect(await reader(cp2).getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(cp2.tokenCalls).toBe(1);
  });

  test('a token request the IdP refuses with a 4xx is not retried', async () => {
    const cp = new FakeControlPlane();
    cp.tokenStatus = 401;
    await expect(reader(cp).getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(cp.tokenCalls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('a secret read that times out, then succeeds, is retried; an access denied is not', async () => {
    const cp = new FakeControlPlane();
    cp.cells.set(CELL, { status: 'ACTIVE' });
    secretsMock.reset();
    secretsMock
      .on(GetSecretValueCommand)
      .rejectsOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .resolves({ SecretString: 'client-secret-value' });
    expect(await reader(cp).getCell(CELL)).toMatchObject({ status: 'ACTIVE' });
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);

    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }));
    await expect(reader(new FakeControlPlane()).getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  test('the retry is logged with the call and the error class or status, and nothing else', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const cp = new FakeControlPlane();
      const r = reader(cp);
      await warm(cp, r);
      cp.fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      cp.fetch.mockRejectedValueOnce(timeout());
      await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
      const lines = out.mock.calls.map(([line]) => String(line)).filter((l) => l.includes('control-plane read failed'));
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        { level: 'WARN', message: 'control-plane read failed', read: 'GetCell', call: 'GetCell', status: 503, retrying: true },
        { level: 'ERROR', message: 'control-plane read failed', read: 'GetCell', call: 'GetCell', error: 'TimeoutError', retrying: false },
      ]);
      expect(lines.join('')).not.toMatch(/reader-token|client-secret|cp\.example\.com|Bearer/);
    } finally {
      out.mockRestore();
    }
  });
});

describe('§3.4 step 2: the time budget', () => {
  let limits: number[];
  beforeEach(() => {
    limits = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      limits.push(ms);
      return real(ms);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  /** A reader on a clock that each call moves forward by `spend(limit)` before it answers, and each pause moves by its length. */
  function onClock(cp: FakeControlPlane, random: number, secretMs: number, tokenMs: number, readMs: (limit: number) => number) {
    let t = 0;
    const clock = { get now() { return t; } };
    secretsMock.on(GetSecretValueCommand).callsFake(async () => {
      t += secretMs;
      return { SecretString: 'client-secret-value' };
    });
    const real = cp.fetch.getMockImplementation()!;
    cp.fetch.mockImplementation(async (url, init) => {
      if (String(url) === 'https://auth.example.com/oauth2/token') {
        t += tokenMs;
        return real(url, init);
      }
      t += readMs(limits[limits.length - 1]);
      throw timeout();
    });
    return { r: reader(cp, () => t, async (ms) => void (t += ms), () => random), clock };
  }

  test.each([0, 1])('with jitter %p, every read ends within the budget, whatever the calls spend', async (random) => {
    const cases: [number, number][] = [[0, 0], [2000, 2000], [2900, 2900], [2900, 0], [0, 2900], [1000, 1000]];
    for (const [secretMs, tokenMs] of cases) {
      secretsMock.reset();
      limits.length = 0;
      const cp = new FakeControlPlane();
      const { r, clock } = onClock(cp, random, secretMs, tokenMs, (limit) => limit);
      await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
      expect(clock.now).toBeLessThanOrEqual(READ_BUDGET_MS);
      expect(Math.max(...limits)).toBeLessThanOrEqual(3000);
    }
  });

  test('a call gets what is left of the budget when that is under its own 3 s', async () => {
    const cp = new FakeControlPlane();
    const { r, clock } = onClock(cp, 0, 2000, 2000, (limit) => limit);
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    // secret 2000, token 2000, read 3000, pause 100: 2900 left, so the retry's limit is 2900.
    expect(limits).toEqual([3000, 3000, 3000, 2900]);
    expect(clock.now).toBe(2000 + 2000 + 3000 + 100 + 2900);
  });

  test('no retry starts when less than 1.4 s is left', async () => {
    const cp = new FakeControlPlane();
    const { r, clock } = onClock(cp, 0, 2900, 2900, (limit) => limit);
    await expect(r.getCell(CELL)).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(limits).toEqual([3000, 3000, 3000]);
    expect(clock.now).toBe(8800);
    expect(READ_BUDGET_MS).toBe(10_000);
  });
});
