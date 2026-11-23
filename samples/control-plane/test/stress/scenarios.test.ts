// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { CallResult, ControlPlaneApi } from './api';
import { emptyManifest } from './manifest';
import type { CellAccountInput, TierSizes } from './plan';
import { Recorder } from './recorder';
import { buildLimitScaling, readRate, type ScenarioEnv } from './scenarios';

// A real but short wait, so read-rate's tick loop runs a few dozen ticks in its window.
jest.mock('./aws', () => ({ ...jest.requireActual('./aws'), sleep: () => new Promise((r) => setTimeout(r, 1)) }));

const TIER: TierSizes = {
  name: 'small',
  cellAccounts: 1,
  cells: 1,
  maxTenants: 10,
  tenantsSeeded: 1,
  onboarding: 'every-run',
  churnPerRun: 0,
  steadyRps: 100,
  usersPerActiveTenant: 2,
  scenarioSeconds: 0.1,
};
const DEPLOYMENT = { tenantId: 'T1', applicationId: 'stress', cellId: 'C1', status: 'ACTIVE' };
const CELL = { cellId: 'C1', applicationId: 'stress', accountId: '2', status: 'ACTIVE', maxTenants: 10, tenantCount: 1 };

const ok = (status: number, body: any = {}, errorType?: string): CallResult => ({ status, body, errorType, seconds: 0.01 });

// The control plane's UpdateTenant conflicts (updateConflict and staleUpdateFailure,
// src/tenant/tenant.ts).
const UPDATING = 'Tenant T1 is UPDATING; retry the request once it has finished';
const STALE = 'Tenant T1 changed after this request read it; re-read and retry the request';
const DELETE_FAILED =
  'Tenant T1 is DELETE_FAILED; it can be re-applied from ACTIVE or UPDATE_FAILED only, so a retry cannot succeed and the remedy is a delete';

/** A fake fleet of one seeded tenant in one cell; `onUpdate` answers each UpdateTenant. */
function fakeEnv(
  onUpdate: () => CallResult,
  setBuildLimit: (limit: number) => Promise<number> = async () => 1,
  buildLimit = 50,
): { s: ScenarioEnv; updates: () => number } {
  const rec = new Recorder();
  let updates = 0;
  const api = {
    call: async (hop: string, method: string, path: string, tenant: string, _body?: unknown, expected: readonly number[] = []) => {
      let r: CallResult;
      if (method === 'PUT' && path === '/tenants/T1') {
        updates += 1;
        r = onUpdate();
      } else if (path.startsWith('/deployments')) {
        r = ok(200, { deployments: [DEPLOYMENT] });
      } else if (path.startsWith('/cells')) {
        r = ok(200, { cells: [CELL] });
      } else {
        r = ok(200, { deployment: DEPLOYMENT });
      }
      rec.observe(hop, r, tenant, expected.includes(r.status));
      return r;
    },
    listAll: async (_hop: string, path: string) => ({ items: path.startsWith('/cells') ? [CELL] : [DEPLOYMENT], status: 200 }),
  } as unknown as ControlPlaneApi;
  const s: ScenarioEnv = {
    api,
    rec,
    applicationId: 'stress',
    platformAccount: '1',
    cellAccounts: [{ accountId: '2' } as CellAccountInput],
    region: 'eu-central-1',
    log: () => undefined,
    tier: TIER,
    manifest: { ...emptyManifest('StressW5', 'small', '0123456'), seeded: ['T1'] },
    buildLimit,
    setBuildLimit,
  };
  return { s, updates: () => updates };
}

describe('readRate', () => {
  it('checks every UpdateTenant write, and takes a ConflictError on a tenant still UPDATING', async () => {
    let n = 0;
    const { s, updates } = fakeEnv(() => (++n % 2 === 0 ? ok(409, { message: UPDATING }, 'ConflictError') : ok(202)));
    await readRate(s);
    expect(updates()).toBeGreaterThan(1);
    expect(s.rec.findings).toEqual([]);
  });

  it('takes the ConflictError for a write that raced another one', async () => {
    let n = 0;
    const { s } = fakeEnv(() => (++n % 2 === 0 ? ok(409, { message: STALE }, 'ConflictError') : ok(202)));
    await readRate(s);
    expect(s.rec.findings).toEqual([]);
  });

  it('makes a finding for a ConflictError on a tenant a retry cannot clear', async () => {
    const { s, updates } = fakeEnv(() => ok(409, { message: DELETE_FAILED }, 'ConflictError'));
    await readRate(s);
    expect(updates()).toBeGreaterThan(0);
    expect(s.rec.findings).toContain('UpdateTenant: HTTP 409 (ConflictError), expected 202');
  });

  it('makes a finding for a ConflictError that does not say to retry', async () => {
    const { s } = fakeEnv(() => ok(409, { message: 'Tenant T1 is locked' }, 'ConflictError'));
    await readRate(s);
    expect(s.rec.findings).toContain('UpdateTenant: HTTP 409 (ConflictError), expected 202');
  });

  it('makes a finding for a refused write, and one when no write was accepted', async () => {
    const { s, updates } = fakeEnv(() => ok(400, { message: 'name is required' }, 'ValidationError'));
    await readRate(s);
    expect(updates()).toBeGreaterThan(0);
    expect(s.rec.findings).toContain('UpdateTenant: HTTP 400 (ValidationError), expected 202');
    expect(s.rec.findings[s.rec.findings.length - 1]).toMatch(/^no UpdateTenant write was accepted/);
  });
});

describe('buildLimitScaling', () => {
  it('keeps the error that stopped it when the restore of the build limit fails too', async () => {
    const { s } = fakeEnv(() => ok(202), async (limit) => {
      throw new Error(`set-build-limit ${limit} failed`);
    }, 30);
    await expect(buildLimitScaling(s)).rejects.toThrow('set-build-limit 5 failed');
    expect(s.rec.findings).toEqual(['restore of build limit 30 failed: set-build-limit 30 failed']);
  });
});
