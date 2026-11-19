// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import {
  API_DOMAIN,
  API_DOMAIN_2,
  CELL,
  CELL_2,
  CELL_ACCOUNT,
  CP_ACCOUNT,
  DT,
  EDGE_ACCOUNT,
  harness,
  type Harness,
  json,
  OTHER_ACCOUNT,
  restEvent,
  TENANT,
  TENANT_2,
  testConfig,
} from './support';
import { DedicatedDomainsNotBuilt } from '../../src/registrar/dedicated-domains';
import { pooledHost } from '../../src/registrar/registrar';
import {
  cellEntry,
  cellKey,
  encodeEntry,
  hostEntry,
  hostKey,
  sanitiseDisplayName,
  tenantEntry,
  tenantKey,
} from '../../src/shared/route-table';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'route-table.json'), 'utf8')) as {
  valid: { kind: string; key: string; value: string }[];
};
const golden = (key: string): string => fixture.valid.find((e) => e.key === key)!.value;

const t = TENANT.toLowerCase();
const t2 = TENANT_2.toLowerCase();
const c = CELL.toLowerCase();
const POOLED = `${t}.tenants.example.com`;
const TOKEN = 'C'.repeat(43);

function seedCell(h: Harness, cellId = c, ac = CELL_ACCOUNT, o = API_DOMAIN): void {
  h.kvs.items.set(cellKey(cellId), encodeEntry(cellEntry({ ac, o })));
}

function seedTenant(h: Harness, fields: Partial<Parameters<typeof tenantEntry>[0]> = {}, tenantId = t): void {
  h.kvs.items.set(tenantKey(tenantId), encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'active', n: 'Acme Corp', ...fields })));
}

function seedHost(h: Harness, host: string, tenantId = t, ac = CELL_ACCOUNT): void {
  h.kvs.items.set(hostKey(host), encodeEntry(hostEntry({ t: tenantId, ac })));
}

let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => logSpy.mockRestore());

// ===========================================================================
// §3.4 step 1: caller classification
// ===========================================================================

describe('§3.4 step 1: only the global hook role and the edge operator role get in', () => {
  const others = [
    ['a role of another name in the control plane account', `arn:aws:sts::${CP_ACCOUNT}:assumed-role/fleet1-tenant-provisioning/s`, CP_ACCOUNT],
    ['the hook role name in a cell account', `arn:aws:sts::${CELL_ACCOUNT}:assumed-role/fleet1-global-hook/s`, CELL_ACCOUNT],
    ['the operator role name in another account', `arn:aws:sts::${OTHER_ACCOUNT}:assumed-role/EdgeOperator/s`, OTHER_ACCOUNT],
    ['another role in the edge account', `arn:aws:sts::${EDGE_ACCOUNT}:assumed-role/Admin/s`, EDGE_ACCOUNT],
    ['an IAM user in the edge account', `arn:aws:iam::${EDGE_ACCOUNT}:user/alice`, EDGE_ACCOUNT],
    ['a hook ARN whose accountId field disagrees', `arn:aws:sts::${CP_ACCOUNT}:assumed-role/fleet1-global-hook/s`, OTHER_ACCOUNT],
    ['the hook role in another partition', `arn:aws-cn:sts::${CP_ACCOUNT}:assumed-role/fleet1-global-hook/s`, CP_ACCOUNT],
  ] as const;

  test.each(others)('%s gets 403 with {message} and nothing is read or written', async (_why, userArn, accountId) => {
    const h = harness();
    seedCell(h);
    const res = await h.handler(restEvent('DELETE', `/cells/${CELL}`, { userArn, accountId }));
    expect(res.statusCode).toBe(403);
    expect(json(res.body)).toEqual({ message: 'the caller is not admitted' });
    expect(h.cp.fetch).not.toHaveBeenCalled();
    expect(h.kvs.items.has(cellKey(c))).toBe(true);
  });

  test('no identity at all gets 403', async () => {
    const h = harness();
    const ev = restEvent('DELETE', `/cells/${CELL}`, 'hook');
    (ev.requestContext as unknown as { identity: unknown }).identity = undefined;
    expect((await h.handler(ev)).statusCode).toBe(403);
  });

  test('the operator role is matched by name although its ARN has a path', async () => {
    const h = harness();
    const res = await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'operator'));
    expect(res.statusCode).toBe(200);
  });

  test('step 6: the log line has the role, key and outcome, never the body', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    const lines = logSpy.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('registrar call'));
    expect(lines).toHaveLength(1);
    expect(json(lines[0])).toMatchObject({ role: 'hook', key: cellKey(c), outcome: 200 });
    expect(lines[0]).not.toContain(API_DOMAIN);
  });
});

// ===========================================================================
// PutCellRoute (§5.1 row 1)
// ===========================================================================

describe('PutCellRoute', () => {
  test('§3.4 step 5: the hook puts a new cell route, byte-equal to the golden entry, account from the control plane', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN, accountId: OTHER_ACCOUNT }));
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ cellId: CELL, apiDomain: API_DOMAIN });
    expect(h.kvs.get(cellKey(c))).toBe(golden(`cell#${c}`));
    expect(h.cp.reads).toEqual([`/cells/${CELL}`]);
  });

  test('§3.4 step 3: the hook put is accepted while UPDATING with the same origin, and writes nothing new', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'UPDATING' });
    seedCell(h);
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(200);
    expect(h.kvs.writes).toBe(0);
  });

  test.each(['ACTIVE', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'])(
    '§3.4 step 3: 409 for the hook while the cell is %s',
    async (status) => {
      const h = harness();
      h.cp.cells.set(CELL, { status });
      const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
      expect(res.statusCode).toBe(409);
      expect(h.kvs.writes).toBe(0);
    },
  );

  test('§3.4 step 3: the origin is write-once for the hook (409 when cell# holds another)', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'UPDATING' });
    seedCell(h);
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN_2 }));
    expect(res.statusCode).toBe(409);
    expect(h.kvs.get(cellKey(c))).toBe(golden(`cell#${c}`));
  });

  test('§3.4 backfill and origin change: the operator changes the origin of an ACTIVE cell, account from the control plane', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'ACTIVE', accountId: OTHER_ACCOUNT });
    seedCell(h);
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'operator', { apiDomain: API_DOMAIN_2 }));
    expect(res.statusCode).toBe(200);
    expect(h.kvs.get(cellKey(c))).toBe(encodeEntry(cellEntry({ ac: OTHER_ACCOUNT, o: API_DOMAIN_2 })));
  });

  test('§3.4 step 3: an apiDomain in another Region is 400', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN.replace('eu-central-1', 'us-west-2') }));
    expect(res.statusCode).toBe(400);
    expect(Object.keys(json(res.body))).toEqual(['message']);
  });

  test.each([
    ['not a function URL', 'api.example.com'],
    ['a short url id', 'abc.lambda-url.eu-central-1.on.aws'],
    ['upper case', API_DOMAIN.toUpperCase()],
  ])('§5.1: an apiDomain that is %s is 400 with {message} only', async (_why, apiDomain) => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain }));
    expect(res.statusCode).toBe(400);
    expect(Object.keys(json(res.body))).toEqual(['message']);
  });

  test('§5.1: a malformed cell id is 400', async () => {
    const h = harness();
    const res = await h.handler(restEvent('PUT', '/cells/not-a-ulid', 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(400);
  });

  test.each([
    ['missing', undefined],
    ['of another application', { status: 'CREATING', applicationId: 'other-app', accountId: OTHER_ACCOUNT }],
  ])('§3.4 step 3: a cell record %s is 403, naming neither the account nor the cell', async (_why, cell) => {
    const h = harness();
    if (cell) h.cp.cells.set(CELL, cell);
    for (const who of ['hook', 'operator'] as const) {
      const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, who, { apiDomain: API_DOMAIN }));
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(OTHER_ACCOUNT);
      expect(res.body.toLowerCase()).not.toContain(c);
    }
    expect(h.kvs.writes).toBe(0);
  });

  test('§3.4 step 2 and §5.1: an unreadable control plane is 503, nothing written', async () => {
    const h = harness();
    h.cp.failWith = 500;
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(503);
    expect(h.kvs.writes).toBe(0);
  });

  test('§3.4 step 5: on an ETag conflict the write-once check runs again on the re-read', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    // Another global hook writes another origin after this call's read and wins the ETag.
    let once = true;
    h.kvs.beforeUpdate = () => {
      if (!once) return false;
      once = false;
      h.kvs.set(cellKey(c), encodeEntry(cellEntry({ ac: CELL_ACCOUNT, o: API_DOMAIN_2 })));
      return true;
    };
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(409);
    expect(h.kvs.gets.filter((k) => k === cellKey(c))).toHaveLength(2);
    expect(h.kvs.get(cellKey(c))).toContain(API_DOMAIN_2);
  });
});

// ===========================================================================
// DeleteCellRoute (§5.1 row 2)
// ===========================================================================

describe('DeleteCellRoute', () => {
  test.each([
    ['DELETING', { status: 'DELETING' }],
    ['missing', undefined],
  ])('§3.4 deletes: the hook removes the route while the cell is %s', async (_why, cell) => {
    const h = harness();
    if (cell) h.cp.cells.set(CELL, cell);
    seedCell(h);
    const res = await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect(h.kvs.items.has(cellKey(c))).toBe(false);
  });

  test.each(['CREATING', 'ACTIVE', 'UPDATING', 'DELETE_FAILED'])('§3.4 deletes: 409 for the hook while the cell is %s', async (status) => {
    const h = harness();
    h.cp.cells.set(CELL, { status });
    seedCell(h);
    expect((await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'hook'))).statusCode).toBe(409);
    expect(h.kvs.items.has(cellKey(c))).toBe(true);
  });

  test('§3.4 step 3: a DELETING cell of another application is 403 for the hook', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'DELETING', applicationId: 'other-app' });
    expect((await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'hook'))).statusCode).toBe(403);
  });

  test('§3.4 deletes: the operator skips step 2 and removes the route of a live cell', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'ACTIVE' });
    seedCell(h);
    const res = await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'operator'));
    expect(res.statusCode).toBe(200);
    expect(h.cp.fetch).not.toHaveBeenCalled();
    expect(h.kvs.items.has(cellKey(c))).toBe(false);
  });

  test('§5.1: 200 also when absent, with no write', async () => {
    const h = harness();
    expect((await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'operator'))).statusCode).toBe(200);
    expect(h.kvs.writes).toBe(0);
  });

  test('§3.4 deletes: does not look for tenant routes that name the cell', async () => {
    const h = harness();
    seedCell(h);
    seedTenant(h);
    await h.handler(restEvent('DELETE', `/cells/${CELL}`, 'operator'));
    expect(h.kvs.items.has(tenantKey(t))).toBe(true);
  });
});

// ===========================================================================
// PutTenantRoute from the hook (§5.1 row 3)
// ===========================================================================

describe('PutTenantRoute from the global hook role', () => {
  function ready(config = testConfig()): Harness {
    const h = harness(config);
    h.cp.deployment(TENANT, { status: 'CREATING' });
    h.cp.tenants.set(TENANT, { name: 'Acme Corp' });
    seedCell(h);
    return h;
  }

  test('§3.4 step 5: a new entry starts active, byte-equal to the golden entry, with dt from createdAt', async () => {
    const h = ready();
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ tenantId: TENANT, dt: DT });
    expect(h.kvs.get(tenantKey(t))).toBe(golden(`tenant#${t}`));
    expect(h.cp.reads).toEqual([`/tenants/${TENANT}/deployments/demo-app`, `/tenants/${TENANT}`]);
    expect([...h.kvs.items.keys()].some((k) => k.startsWith('host#'))).toBe(false);
  });

  test('§4.1: in host mode the pooled host# entry is written, byte-equal to the golden entry', async () => {
    const h = ready(testConfig({ addressing: 'host' }));
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(200);
    expect(h.kvs.get(hostKey(POOLED))).toBe(golden(`host#${POOLED}`));
  });

  test('§3.4 step 5: the lower-case id in the path is read upper-case and stored lower-case', async () => {
    const h = ready();
    const res = await h.handler(restEvent('PUT', `/tenants/${t}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect(json(res.body).tenantId).toBe(t);
    expect(h.cp.reads[0]).toBe(`/tenants/${TENANT}/deployments/demo-app`);
  });

  test('§4.1: createdAt with and without a zero fraction is the same dt, so a repeat writes nothing', async () => {
    const h = ready();
    await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    const writes = h.kvs.writes;
    h.cp.deployment(TENANT, { status: 'UPDATING', createdAt: '2026-11-19T09:20:00.000Z' });
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect(json(res.body).dt).toBe(DT);
    expect(h.kvs.writes).toBe(writes);
  });

  test('§3.4 step 2 and §4.1: the display name comes from GetTenant, sanitised', async () => {
    const h = ready();
    const raw = 'Ex"ample\\ \u0007Tenant ' + 'é'.repeat(40);
    h.cp.tenants.set(TENANT, { name: raw });
    await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(JSON.parse(h.kvs.get(tenantKey(t))!).n).toBe(sanitiseDisplayName(raw));
  });

  test.each(['ACTIVE', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'])(
    '§3.4 step 3: 409 while the deployment is %s',
    async (status) => {
      const h = ready();
      h.cp.deployment(TENANT, { status });
      expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(409);
      expect(h.kvs.writes).toBe(0);
    },
  );

  test.each([
    ['the deployment is missing', (h: Harness) => h.cp.deployments.clear()],
    ['the deployment names another application', (h: Harness) => h.cp.deployment(TENANT, { status: 'CREATING', applicationId: 'other-app' })],
    ['the tenant is missing', (h: Harness) => h.cp.tenants.clear()],
  ])('§3.4 step 3: 403 when %s', async (_why, change) => {
    const h = ready();
    change(h);
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(403);
    expect(h.kvs.writes).toBe(0);
  });

  test('§3.4 step 4: 409 when the cell has no route', async () => {
    const h = ready();
    h.kvs.items.clear();
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(409);
  });

  test('§3.4 step 4: 409 when the cell route was written for another account', async () => {
    const h = ready();
    seedCell(h, c, OTHER_ACCOUNT);
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(OTHER_ACCOUNT);
  });

  test('§3.4 step 3: the cell and account come from the deployment record', async () => {
    const h = ready();
    h.cp.deployment(TENANT, { status: 'CREATING', cellId: CELL_2, accountId: OTHER_ACCOUNT });
    seedCell(h, CELL_2.toLowerCase(), OTHER_ACCOUNT);
    await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(JSON.parse(h.kvs.get(tenantKey(t))!)).toMatchObject({ c: CELL_2.toLowerCase(), ac: OTHER_ACCOUNT });
  });

  test('§5.1: 503 when createdAt does not parse, nothing written', async () => {
    const h = ready();
    h.cp.deployment(TENANT, { status: 'CREATING', createdAt: '2026-02-30T00:00:00Z' });
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(503);
    expect(h.kvs.writes).toBe(0);
  });

  test.each([
    ['the control plane answers 500', (h: Harness) => (h.cp.failWith = 500)],
    ['the control plane answers 404 without its error type', (h: Harness) => (h.cp.failWith = 404)],
    ['the token endpoint refuses', (h: Harness) => (h.cp.tokenStatus = 400)],
  ])('§5.1: 503 when %s, nothing written', async (_why, change) => {
    const h = ready();
    change(h);
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(503);
    expect(h.kvs.writes).toBe(0);
  });

  test('§4.2: a write to an existing entry keeps suspended and the domain with its challenge', async () => {
    const h = ready();
    seedTenant(h, { s: 'suspended', n: 'Old Name', d: 'portal.example.com', dk: TOKEN });
    h.cp.deployment(TENANT, { status: 'UPDATING' });
    await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(h.kvs.get(tenantKey(t))).toBe(
      encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'suspended', n: 'Acme Corp', d: 'portal.example.com', dk: TOKEN })),
    );
  });

  test('§3.4 step 5: a new deployment replaces a leftover entry, keeps suspended, removes its domain and host# keys', async () => {
    const h = ready(testConfig({ addressing: 'host' }));
    seedTenant(h, { dt: DT - 1000, s: 'suspended', d: 'portal.example.com', dk: TOKEN, ac: OTHER_ACCOUNT });
    seedHost(h, 'portal.example.com', t, OTHER_ACCOUNT);
    seedHost(h, POOLED, t, OTHER_ACCOUNT);
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect(json(res.body).dt).toBe(DT);
    expect(h.kvs.get(tenantKey(t))).toBe(encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'suspended', n: 'Acme Corp' })));
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(false);
    expect(h.kvs.get(hostKey(POOLED))).toBe(golden(`host#${POOLED}`));
    expect(h.domains.releaseDomain).toHaveBeenCalledWith(t, 'portal.example.com');
  });

  test('§3.4 step 5: a replacement leaves a host#<d> another tenant holds', async () => {
    const h = ready();
    seedTenant(h, { dt: DT - 1000, d: 'portal.example.com', dk: TOKEN });
    seedHost(h, 'portal.example.com', t2);
    await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(true);
  });

  test('§3.4 step 3: the hook that sends customDomain gets 403', async () => {
    for (const dedicatedDomains of [false, true]) {
      const h = ready(testConfig({ dedicatedDomains }));
      const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook', { customDomain: 'portal.example.com' }));
      expect(res.statusCode).toBe(403);
    }
  });

  test('§4.1: a reserved label is refused at registration', () => {
    expect(() => pooledHost('www', 'tenants.example.com')).toThrow(expect.objectContaining({ name: 'BadRequestError' }));
    expect(pooledHost(t, 'tenants.example.com')).toBe(POOLED);
  });
});

// ===========================================================================
// PutTenantRoute from the edge operator role (§5.1 row 3, customDomain)
// ===========================================================================

describe('PutTenantRoute from the edge operator role', () => {
  function ready(config = testConfig()): Harness {
    const h = harness(config, new DedicatedDomainsNotBuilt());
    h.cp.deployment(TENANT, { status: 'ACTIVE' });
    seedCell(h);
    seedTenant(h);
    return h;
  }

  test('§3.4 step 3: customDomain while dedicatedDomains is off is 400', async () => {
    const h = ready();
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain: 'portal.example.com' }));
    expect(res.statusCode).toBe(400);
    expect(h.domains.putTenantDomain).not.toHaveBeenCalled();
  });

  test('wave 1: customDomain while dedicatedDomains is on reaches the seam, which refuses with 500', async () => {
    const h = ready(testConfig({ dedicatedDomains: true }));
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain: 'portal.example.com' }));
    expect(res.statusCode).toBe(500);
    expect(json(res.body)).toEqual({ message: 'dedicated domains are not built yet' });
    expect(h.domains.putTenantDomain).toHaveBeenCalledWith(expect.objectContaining({ tenantId: t, customDomain: 'portal.example.com' }));
    expect(h.kvs.writes).toBe(0);
  });

  test.each(['tenants.example.com', 'acme.tenants.example.com', 'login.tenants.example.com'])(
    '§3.4 step 4: customDomain %s (appDomain or under it) is 400',
    async (customDomain) => {
      const h = ready(testConfig({ dedicatedDomains: true }));
      expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain }))).statusCode).toBe(400);
    },
  );

  test.each(['*.example.com', 'x'.repeat(61) + '.com', 'Portal.example.com'])('§3.4 step 4: customDomain %s is 400', async (customDomain) => {
    const h = ready(testConfig({ dedicatedDomains: true }));
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain }))).statusCode).toBe(400);
  });

  test('§3.4 step 4: a customDomain whose host# names another tenant is 409, naming no tenant', async () => {
    const h = ready(testConfig({ dedicatedDomains: true }));
    seedHost(h, 'portal.example.com', t2);
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', { customDomain: 'portal.example.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(t2);
  });

  test.each([
    ['no tenant route', (h: Harness) => h.kvs.items.delete(tenantKey(t))],
    ['a tenant route for another deployment (dt)', (h: Harness) => seedTenant(h, { dt: DT + 1 })],
    ['a tenant route for another account', (h: Harness) => seedTenant(h, { ac: OTHER_ACCOUNT })],
    ['no cell route for the entry', (h: Harness) => h.kvs.items.delete(cellKey(c))],
  ])('§3.4 steps 3 and 4: 409 for %s', async (_why, change) => {
    for (const body of [{ customDomain: 'portal.example.com' }, {}]) {
      const h = ready(testConfig({ dedicatedDomains: true }));
      change(h);
      expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', body))).statusCode).toBe(409);
      expect(h.domains.putTenantDomain).not.toHaveBeenCalled();
    }
  });

  test('§3.4 step 3: 403 when the deployment record is missing', async () => {
    const h = ready();
    h.cp.deployments.clear();
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', {}))).statusCode).toBe(403);
  });

  test('§5.1: no customDomain drops the stored domain and its host#<d>, keeping c, ac, dt, s and n', async () => {
    const h = ready(testConfig({ dedicatedDomains: true }));
    seedTenant(h, { s: 'suspended', d: 'portal.example.com', dk: TOKEN });
    seedHost(h, 'portal.example.com');
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator', {}));
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ tenantId: TENANT, dt: DT });
    expect(h.kvs.get(tenantKey(t))).toBe(encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'suspended', n: 'Acme Corp' })));
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(false);
    expect(h.domains.releaseDomain).toHaveBeenCalledWith(t, 'portal.example.com');
  });

  test('§5.1: no customDomain and no stored domain writes nothing', async () => {
    const h = ready();
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'operator'));
    expect(res.statusCode).toBe(200);
    expect(h.kvs.writes).toBe(0);
  });
});

// ===========================================================================
// DeleteTenantRoute (§5.1 row 4)
// ===========================================================================

describe('DeleteTenantRoute', () => {
  function ready(): Harness {
    const h = harness(testConfig({ addressing: 'host' }));
    seedTenant(h, { d: 'portal.example.com', dk: TOKEN });
    seedHost(h, POOLED);
    seedHost(h, 'portal.example.com');
    return h;
  }

  test.each([
    ['DELETING', { status: 'DELETING' }],
    ['missing', undefined],
  ])('§5.1: the hook removes tenant#, the pooled host# and host#<d> while the deployment is %s', async (_why, d) => {
    const h = ready();
    if (d) h.cp.deployment(TENANT, d);
    const res = await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(200);
    expect([...h.kvs.items.keys()]).toEqual([]);
    expect(h.domains.releaseDomain).toHaveBeenCalledWith(t, 'portal.example.com');
  });

  test.each(['CREATING', 'ACTIVE', 'UPDATING', 'CREATE_FAILED'])('§3.4 deletes: 409 for the hook while the deployment is %s', async (status) => {
    const h = ready();
    h.cp.deployment(TENANT, { status });
    expect((await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(409);
    expect(h.kvs.items.size).toBe(3);
  });

  test('§5.1: a host# key goes only when its t names the tenant', async () => {
    const h = ready();
    seedHost(h, 'portal.example.com', t2);
    seedHost(h, POOLED, t2);
    await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'operator'));
    expect([...h.kvs.items.keys()].sort()).toEqual([hostKey(POOLED), hostKey('portal.example.com')].sort());
  });

  test('§5.1: a damaged tenant# is still removed; a damaged host# is kept as naming no tenant', async () => {
    const h = harness(testConfig({ addressing: 'host' }));
    h.kvs.items.set(tenantKey(t), 'not json');
    h.kvs.items.set(hostKey(POOLED), 'not json');
    expect((await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'operator'))).statusCode).toBe(200);
    expect([...h.kvs.items.keys()]).toEqual([hostKey(POOLED)]);
  });

  test('§3.4 deletes: the operator skips step 2', async () => {
    const h = ready();
    h.cp.deployment(TENANT, { status: 'ACTIVE' });
    expect((await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'operator'))).statusCode).toBe(200);
    expect(h.cp.fetch).not.toHaveBeenCalled();
  });

  test('§5.1: 200 also when absent', async () => {
    const h = harness();
    expect((await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'operator'))).statusCode).toBe(200);
    expect(h.kvs.writes).toBe(0);
    expect(h.domains.releaseDomain).not.toHaveBeenCalled();
  });

  test('§3.4 step 2: 503 for the hook when the control plane cannot be read', async () => {
    const h = ready();
    h.cp.failWith = 502;
    expect((await h.handler(restEvent('DELETE', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(503);
    expect(h.kvs.items.size).toBe(3);
  });
});

// ===========================================================================
// UpdateTenantRouteStatus (§5.1 row 6)
// ===========================================================================

describe('UpdateTenantRouteStatus', () => {
  test('§4.2: the operator suspends and resumes, keeping every other field', async () => {
    const h = harness();
    seedTenant(h, { d: 'portal.example.com', dk: TOKEN });
    let res = await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'operator', { status: 'suspended' }));
    expect(res.statusCode).toBe(200);
    expect(json(res.body)).toEqual({ tenantId: TENANT, status: 'suspended' });
    expect(h.kvs.get(tenantKey(t))).toBe(
      encodeEntry(tenantEntry({ c, ac: CELL_ACCOUNT, dt: DT, s: 'suspended', n: 'Acme Corp', d: 'portal.example.com', dk: TOKEN })),
    );
    res = await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'operator', { status: 'active' }));
    expect(JSON.parse(h.kvs.get(tenantKey(t))!).s).toBe('active');
  });

  test('§3.4: the hook role gets 403', async () => {
    const h = harness();
    seedTenant(h);
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'hook', { status: 'active' }))).statusCode).toBe(403);
  });

  test('reads no control-plane record, so a suspension works while the control plane is down', async () => {
    const h = harness();
    seedTenant(h);
    h.cp.failWith = 500;
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'operator', { status: 'suspended' }))).statusCode).toBe(200);
    expect(h.cp.fetch).not.toHaveBeenCalled();
  });

  test('§5.1: 409 when the tenant has no route', async () => {
    const h = harness();
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'operator', { status: 'suspended' }))).statusCode).toBe(409);
  });

  test('§5.1: a status outside the enum is 400', async () => {
    const h = harness();
    seedTenant(h);
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}/status`, 'operator', { status: 'deleted' }))).statusCode).toBe(400);
  });
});

// ===========================================================================
// DeleteHostRoute (§5.1 row 5)
// ===========================================================================

describe('DeleteHostRoute', () => {
  test('§5.1: removes the host# key and the d of the tenant it names when d is that host', async () => {
    const h = harness();
    seedTenant(h, { d: 'portal.example.com', dk: TOKEN });
    seedHost(h, 'portal.example.com');
    const res = await h.handler(restEvent('DELETE', '/hosts/portal.example.com', 'operator'));
    expect(res.statusCode).toBe(200);
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(false);
    expect(h.kvs.get(tenantKey(t))).toBe(golden(`tenant#${t}`));
    expect(h.domains.releaseDomain).toHaveBeenCalledWith(t, 'portal.example.com');
  });

  test('§5.1: removes a host# key whatever its t, leaving a tenant whose d is another host', async () => {
    const h = harness();
    seedTenant(h, { d: 'shop.example.com', dk: TOKEN });
    seedHost(h, 'portal.example.com');
    await h.handler(restEvent('DELETE', '/hosts/portal.example.com', 'operator'));
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(false);
    expect(JSON.parse(h.kvs.get(tenantKey(t))!).d).toBe('shop.example.com');
    expect(h.domains.releaseDomain).not.toHaveBeenCalled();
  });

  test('§5.1: 200 also when absent', async () => {
    const h = harness();
    expect((await h.handler(restEvent('DELETE', '/hosts/portal.example.com', 'operator'))).statusCode).toBe(200);
    expect(h.kvs.writes).toBe(0);
  });

  test.each([
    ['is not JSON', 'not json'],
    ['names no valid tenant id', '{"v":1,"t":"Not A Tenant!","ac":"111111111111"}'],
  ])('§5.1: a host# value that %s is removed whatever it holds, touching no d', async (_why, value) => {
    const h = harness();
    seedTenant(h, { d: 'portal.example.com', dk: TOKEN });
    h.kvs.items.set(hostKey('portal.example.com'), value);
    expect((await h.handler(restEvent('DELETE', '/hosts/portal.example.com', 'operator'))).statusCode).toBe(200);
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(false);
    expect(JSON.parse(h.kvs.get(tenantKey(t))!).d).toBe('portal.example.com');
  });

  test('§3.4: the hook role gets 403', async () => {
    const h = harness();
    seedHost(h, 'portal.example.com');
    expect((await h.handler(restEvent('DELETE', '/hosts/portal.example.com', 'hook'))).statusCode).toBe(403);
    expect(h.kvs.items.has(hostKey('portal.example.com'))).toBe(true);
  });
});

// ===========================================================================
// Store limits through the API (§3.4 step 5, §4.1)
// ===========================================================================

describe('route table limits', () => {
  test('§3.4 step 5: an ETag conflict on every one of five attempts is 503, with 50-500 ms jitter between them', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    h.kvs.conflicts = 5;
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(503);
    expect(h.sleeps).toHaveLength(4);
    for (const ms of h.sleeps) expect(ms >= 50 && ms <= 500).toBe(true);
  });

  test('§3.4 step 5: a conflict on four attempts then success is 200', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    h.kvs.conflicts = 4;
    expect((await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }))).statusCode).toBe(200);
    expect(h.kvs.get(cellKey(c))).toBe(golden(`cell#${c}`));
  });

  test('§4.1: a write past 5,000,000 bytes is 507 with {message}', async () => {
    const h = harness();
    h.cp.deployment(TENANT, { status: 'CREATING' });
    h.cp.tenants.set(TENANT, { name: 'Acme Corp' });
    seedCell(h);
    h.kvs.padding = 5_000_000 - h.kvs.size() - 10;
    const res = await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'));
    expect(res.statusCode).toBe(507);
    expect(Object.keys(json(res.body))).toEqual(['message']);
    expect(h.kvs.writes).toBe(0);
  });

  test('§4.1: each write emits RouteTableBytes from the write response', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    const emf = logSpy.mock.calls.map((call) => String(call[0])).find((l) => l.includes('RouteTableBytes'));
    expect(json(emf!).RouteTableBytes).toBe(h.kvs.size());
    expect((json(emf!)._aws as { CloudWatchMetrics: unknown[] }).CloudWatchMetrics[0]).toEqual({
      Namespace: 'TenantFrontDoor',
      Dimensions: [[]],
      Metrics: [{ Name: 'RouteTableBytes', Unit: 'Bytes' }],
    });
  });

  function readyTenant(): Harness {
    const h = harness();
    h.cp.deployment(TENANT, { status: 'CREATING' });
    h.cp.tenants.set(TENANT, { name: 'Acme Corp' });
    seedCell(h);
    return h;
  }

  test('§3.4 step 5: a conflict re-runs step 4 on the re-read: a cell route deleted meanwhile is 409', async () => {
    const h = readyTenant();
    let once = true;
    h.kvs.beforeUpdate = () => {
      if (!once) return false;
      once = false;
      h.kvs.items.delete(cellKey(c));
      h.kvs.version++;
      return true;
    };
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(409);
    expect(h.kvs.items.has(tenantKey(t))).toBe(false);
  });

  test('§3.4 step 5: a conflict re-runs the size check on the re-read: a store that grew meanwhile is 507', async () => {
    const h = readyTenant();
    let once = true;
    h.kvs.beforeUpdate = () => {
      if (!once) return false;
      once = false;
      h.kvs.padding = 5_000_000 - h.kvs.size() - 10;
      h.kvs.version++;
      return true;
    };
    expect((await h.handler(restEvent('PUT', `/tenants/${TENANT}`, 'hook'))).statusCode).toBe(507);
    expect(h.kvs.writes).toBe(0);
  });
});

// ===========================================================================
// Error bodies (§5.1)
// ===========================================================================

describe('§5.1 error bodies are {message, reason?}', () => {
  test('a model validation failure carries no fieldList', async () => {
    const h = harness();
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', {}));
    expect(res.statusCode).toBe(400);
    expect(Object.keys(json(res.body))).toEqual(['message']);
  });

  test('an unknown route is 404 with a message', async () => {
    const h = harness();
    const res = await h.handler(restEvent('GET', '/nothing', 'operator'));
    expect(res.statusCode).toBe(404);
    expect(Object.keys(json(res.body))).toEqual(['message']);
  });

  test('an unexpected error is 500 with a fixed message and no detail', async () => {
    const h = harness();
    h.kvs.items.set(cellKey(c), 'not json');
    h.cp.cells.set(CELL, { status: 'CREATING' });
    const res = await h.handler(restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN }));
    expect(res.statusCode).toBe(500);
    expect(json(res.body)).toEqual({ message: 'internal error' });
  });

  test('REST keeps client header casing; mixed-case Content-Type is read', async () => {
    const h = harness();
    h.cp.cells.set(CELL, { status: 'CREATING' });
    const ev = restEvent('PUT', `/cells/${CELL}`, 'hook', { apiDomain: API_DOMAIN });
    ev.multiValueHeaders = { 'CoNtEnT-TyPe': ['application/json'] };
    ev.headers = { 'CoNtEnT-TyPe': 'application/json' };
    expect((await h.handler(ev)).statusCode).toBe(200);
  });
});
