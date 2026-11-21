// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { IdentityApi, Pacer, emailOf, type Send } from './identity';
import { Recorder } from './recorder';

const T = '01KAF5M0000000000000000T01';
type Reply = { status: number; body?: unknown };

/** A fake platform API: replies by "METHOD path" in order, then repeats the last. */
function fake(given: Record<string, Reply[]>) {
  const replies: Record<string, Reply[]> = { 'GET /prod/platform/scopes/app%2Fuse': [{ status: 200 }], ...given };
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const send: Send = async (method, url, body) => {
    const key = `${method} ${new URL(url).pathname}`;
    calls.push(key);
    bodies.push(body);
    const list = replies[key] ?? [{ status: 404 }];
    const r = list.length > 1 ? list.shift()! : list[0];
    return { status: r.status, text: r.body === undefined ? '' : JSON.stringify(r.body) };
  };
  const rec = new Recorder();
  const api = new IdentityApi('https://abc.execute-api.eu-west-2.amazonaws.com/prod', send, rec.observe.bind(rec), new Pacer(1000), async () => undefined);
  return { api, calls, bodies, rec };
}

const created = { status: 201, body: { tenant: {}, admin: { user: { username: 'admin-1' } } } };

describe('the identity calls of the platform run (stress ADR-0017)', () => {
  it('makes the tenant under the control-plane id with the app scope, then each further user', async () => {
    const f = fake({ 'POST /prod/platform/tenants': [created], [`POST /prod/platform/tenants/${T}/users`]: [{ status: 201, body: { user: { username: 'u-1' } } }] });
    const entry = await f.api.createIdentity(T, 'st-name', 1);
    expect(entry).toEqual({ tenantId: T, admin: { username: 'admin-1', email: emailOf(T, 0) }, users: [{ username: 'u-1', email: emailOf(T, 1) }] });
    expect(f.bodies[f.calls.indexOf('POST /prod/platform/tenants')]).toEqual({ tenantId: T, name: 'st-name', adminEmail: emailOf(T, 0), scopes: ['app/use'] });
    expect(emailOf(T, 0)).toMatch(/^success\+01kaf5m0000000000000000t01@simulator\.amazonses\.com$/);
  });

  it('registers the scope first when the catalogue lacks it', async () => {
    const f = fake({ 'GET /prod/platform/scopes/app%2Fuse': [{ status: 404 }], 'PUT /prod/platform/scopes/app%2Fuse': [{ status: 200 }], 'POST /prod/platform/tenants': [created] });
    expect(await f.api.createTenant(T, 'n')).toBe('admin-1');
    expect(f.calls.slice(0, 3)).toEqual(['GET /prod/platform/scopes/app%2Fuse', 'PUT /prod/platform/scopes/app%2Fuse', 'POST /prod/platform/tenants']);
    expect(f.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
  });

  it('claims the first-admin slot when a throttled create left the tenant without its admin', async () => {
    const f = fake({
      'POST /prod/platform/tenants': [{ status: 503 }],
      [`GET /prod/platform/tenants/${T}`]: [{ status: 200, body: { tenant: { status: 'ACTIVE' } } }],
      [`POST /prod/platform/tenants/${T}/users`]: [{ status: 201, body: { user: { username: 'admin-2' } } }],
    });
    expect(await f.api.createTenant(T, 'n')).toBe('admin-2');
    expect(f.bodies[f.calls.indexOf(`POST /prod/platform/tenants/${T}/users`)]).toEqual({ email: emailOf(T, 0), firstAdmin: true });
    expect(f.calls.filter((c) => c === 'POST /prod/platform/tenants')).toHaveLength(1);
  });

  it('repeats the create when the tenant is not there after a 503', async () => {
    const f = fake({ 'POST /prod/platform/tenants': [{ status: 503 }, created], [`GET /prod/platform/tenants/${T}`]: [{ status: 404 }] });
    expect(await f.api.createTenant(T, 'n')).toBe('admin-1');
    expect(f.calls.filter((c) => c === 'POST /prod/platform/tenants')).toHaveLength(2);
  });

  it('finds a user that a lost answer already made', async () => {
    const f = fake({
      [`POST /prod/platform/tenants/${T}/users`]: [{ status: 409 }],
      [`GET /prod/platform/tenants/${T}/users`]: [{ status: 200, body: { users: [{ username: 'u-9', email: emailOf(T, 1) }] } }],
    });
    expect(await f.api.createUser(T, emailOf(T, 1))).toBe('u-9');
  });

  it('gives up with undefined when the create is refused, and issues and deletes', async () => {
    const f = fake({
      'POST /prod/platform/tenants': [{ status: 400 }],
      [`POST /prod/platform/tenants/${T}/users/admin-1/token`]: [{ status: 200, body: { accessToken: 'tok' } }],
      [`DELETE /prod/platform/tenants/${T}`]: [{ status: 204 }],
    });
    expect(await f.api.createTenant(T, 'n')).toBeUndefined();
    expect(await f.api.issueToken(T, 'admin-1')).toBe('tok');
    expect(await f.api.deleteTenant(T)).toBe(true);
  });

  it('spaces paced calls apart', async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = new Pacer(4, () => now, async (ms) => { waits.push(ms); now += ms; });
    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(waits).toEqual([250, 250]);
  });
});
