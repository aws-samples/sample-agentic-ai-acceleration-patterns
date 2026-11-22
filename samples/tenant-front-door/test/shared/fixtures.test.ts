// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Pins the golden fixtures the router (S1) and the SPA (S4) are tested
 * against: the sign-in `state` cases and the `/config.json` bodies agree
 * with the reference implementations and with `route-table.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SIGNIN_NONCE, SIGNIN_STATE_TTL_SECONDS } from '../../src/shared/contracts';
import { decodeAppEntry, decodeHostEntry, decodeSigninEntry, decodeTenantEntry, hostKey, tenantKey } from '../../src/shared/route-table';
import { configJsonFor } from '../support/config-json';
import { mintState, verifyState } from '../support/signin-state';

const dir = path.join(__dirname, '../fixtures');
const read = (f: string): any => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const routeTable: { valid: { kind: string; key: string; value: string }[] } = read('route-table.json');
const store = new Map(routeTable.valid.map((e) => [e.key, e.value]));

describe('signin-state.json', () => {
  const f = read('signin-state.json');
  const signin = decodeSigninEntry(f.signin);

  test('uses the signin entry of route-table.json', () => {
    expect(f.signin).toBe(store.get('signin'));
  });

  test.each(f.valid.map((c: any) => [c.name, c]) as [string, any][])('%s: verifies and re-mints byte for byte', (_n, c: any) => {
    const verdict = verifyState(signin, c.state, f.nowSeconds);
    expect(verdict).toEqual({ ok: true, payload: c.payload });
    expect(mintState(signin, c.payload)).toBe(c.state);
    expect(c.payload.exp - f.nowSeconds).toBe(SIGNIN_STATE_TTL_SECONDS);
    if (c.payload.n !== undefined) expect(c.payload.n).toMatch(SIGNIN_NONCE);
  });

  test.each(f.invalid.map((c: any) => [c.name, c]) as [string, any][])('%s: refused', (_n, c: any) => {
    expect(verifyState(signin, c.state, f.nowSeconds)).toEqual({ ok: false, why: c.why });
  });
});

describe('config-json.json', () => {
  const f = read('config-json.json');
  const app = decodeAppEntry(store.get('app')!);

  test.each(f.cases.map((c: any) => [c.name, c]) as [string, any][])('%s: matches the reference', (_n, c: any) => {
    const appDomain = c.addressing === 'host' ? 'tenants.example.com' : 'app.example.com';
    const hostValue = store.get(hostKey(c.host));
    const tenantId = hostValue === undefined ? undefined : decodeHostEntry(hostValue).t;
    const tenant =
      tenantId === undefined ? undefined : { id: tenantId, entry: decodeTenantEntry(store.get(tenantKey(tenantId))!) };
    expect(configJsonFor({ addressing: c.addressing, appDomain, host: c.host, app, tenant })).toEqual(c.body);
  });

  test('never carries the issuer logout endpoint: sign-out goes through /logout', () => {
    for (const c of f.cases) expect(JSON.stringify(c.body)).not.toContain('/logout');
  });
});
