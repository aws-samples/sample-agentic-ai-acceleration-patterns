// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { sleep, type HttpResult } from './http';
import type { Caller } from './sigv4';
import type { Outputs } from './state';

/**
 * The calls the slice makes to the parts of the platform it composes in
 * slice mode: tenant-identity's platform API (tenants and tokens), the stand-in
 * control plane's fixture table, and the route registrar.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // pragma: allowlist secret

/** A control-plane style id: 26 characters of Crockford base32, a millisecond timestamp then random. */
export function newUlid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

/** Backs off on throttling and transient answers; returns the last result when the attempts run out. */
export async function retrying(fn: () => Promise<HttpResult>, retryOn: (r: HttpResult) => boolean, attempts = 8): Promise<HttpResult> {
  let last: HttpResult | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (!retryOn(last) || i === attempts - 1) return last;
    await sleep(Math.min(8000, 300 * 2 ** i) * (0.5 + Math.random()));
  }
  return last as HttpResult;
}

const TRANSIENT = (r: HttpResult): boolean => r.status === 0 || r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504;

function field(r: HttpResult, ...keys: string[]): string {
  let v: unknown;
  try {
    v = JSON.parse(r.body);
  } catch {
    throw new Error(`HTTP ${r.status}: the answer is not JSON`);
  }
  for (const k of keys) {
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  }
  if (typeof v !== 'string' || v === '') throw new Error(`HTTP ${r.status}: the answer has no ${keys.join('.')}`);
  return v;
}

/** tenant-identity's platform API (its shared-pool deployment, read through its published parameters). */
export class IdentityClient {
  private readonly base: string;

  constructor(apiUrl: string, private readonly caller: Caller) {
    this.base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  }

  /** Registers a vendor scope when the catalogue lacks it; leaves it, as a later run reuses it. */
  async ensureScope(scope: string): Promise<void> {
    const path = `platform/scopes/${encodeURIComponent(scope)}`;
    const got = await retrying(() => this.caller.call('GET', `${this.base}${path}`), TRANSIENT);
    if (got.status === 200) return;
    if (got.status !== 404) throw new Error(`GET ${path}: HTTP ${got.status}`);
    const put = await retrying(() => this.caller.call('PUT', `${this.base}${path}`, { description: 'tenant-front-door stress slice' }), TRANSIENT);
    if (put.status !== 200) throw new Error(`PutScope ${scope}: HTTP ${put.status}`);
  }

  async createTenant(tenantId: string, name: string): Promise<string> {
    const r = await retrying(
      () => this.caller.call('POST', `${this.base}platform/tenants`, { tenantId, name, adminEmail: `success+${name}@simulator.amazonses.com`, scopes: ['app/use'] }),
      TRANSIENT,
      24,
    );
    if (r.status !== 201) throw new Error(`CreateTenant: HTTP ${r.status} ${r.body.slice(0, 120)}`);
    return field(r, 'admin', 'user', 'username');
  }

  /** Test aid of tenant-identity: sets a permanent password and returns an access token. */
  async issueToken(tenantId: string, username: string): Promise<string> {
    const password = `Tfd-Stress-${crypto.randomBytes(9).toString('hex')}!`;
    const r = await retrying(() => this.caller.call('POST', `${this.base}platform/tenants/${tenantId}/users/${encodeURIComponent(username)}/token`, { password }), TRANSIENT);
    if (r.status !== 200) throw new Error(`IssueToken: HTTP ${r.status}`);
    return field(r, 'accessToken');
  }

  async deleteTenant(tenantId: string): Promise<number> {
    const r = await retrying(() => this.caller.call('DELETE', `${this.base}platform/tenants/${tenantId}`), TRANSIENT);
    return r.status;
  }
}

/** The stand-in control plane's records for one tenant and for the cell (test/smoke/control-plane.function.ts). */
export class Fixtures {
  private readonly ddb: DynamoDBClient;

  constructor(private readonly o: Outputs) {
    this.ddb = new DynamoDBClient({ region: o.region });
  }

  private async put(pk: string, body: unknown): Promise<void> {
    await this.ddb.send(new PutItemCommand({ TableName: this.o.fixtureTable, Item: { pk: { S: pk }, body: { S: JSON.stringify(body) } } }));
  }

  /** A cell in `CREATING`, the state in which the global hook role may put its route. */
  async cell(): Promise<void> {
    await this.put(`/cells/${this.o.cellId}`, { cell: { applicationId: this.o.applicationId, accountId: this.o.accountId, status: 'CREATING' } });
  }

  /** A deployment of the front door's application in `CREATING`, with its tenant record. */
  async tenant(tenantId: string, name: string): Promise<void> {
    await this.put(`/tenants/${tenantId}`, { tenant: { name } });
    await this.put(`/tenants/${tenantId}/deployments/${this.o.applicationId}`, {
      accountId: this.o.accountId,
      deployment: { applicationId: this.o.applicationId, cellId: this.o.cellId, status: 'CREATING', createdAt: new Date().toISOString() },
    });
  }
}

/** The route registrar (spec §5.1). */
export class Registrar {
  private readonly base: string;

  constructor(url: string, private readonly hook: Caller, private readonly operator: Caller) {
    this.base = url.endsWith('/') ? url : `${url}/`;
  }

  putCell(cellId: string, apiDomain: string): Promise<HttpResult> {
    return this.hook.call('PUT', `${this.base}cells/${cellId}`, { apiDomain });
  }

  putTenant(tenantId: string): Promise<HttpResult> {
    return this.hook.call('PUT', `${this.base}tenants/${tenantId}`, {});
  }

  setStatus(tenantId: string, status: 'active' | 'suspended'): Promise<HttpResult> {
    return this.operator.call('PUT', `${this.base}tenants/${tenantId}/status`, { status });
  }

  deleteTenant(tenantId: string): Promise<HttpResult> {
    return this.operator.call('DELETE', `${this.base}tenants/${tenantId}`);
  }

  deleteCell(cellId: string): Promise<HttpResult> {
    return this.operator.call('DELETE', `${this.base}cells/${cellId}`);
  }
}

/** Why a 503 from the registrar: the route table kept conflicting, or the control plane could not be read. */
export function registrarCause(r: { readonly body: string }): string {
  const text = r.body.toLowerCase();
  if (text.includes('route table is busy')) return 'route-table-busy';
  if (text.includes('control plane')) return 'control-plane-unreadable';
  return 'other';
}

// ---------------------------------------------------------------------------
// Tokens the probes forge. The router decodes a token's payload and never checks
// its signature (ADR-0005); the cell does. A forged token therefore reaches the
// cell and must be refused there.
// ---------------------------------------------------------------------------

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The token's own header and signature around a payload that names another tenant, padded to `padTo` bytes of header value when given. */
export function forgeToken(token: string, tenantId: string, padTo?: number, extra: Record<string, unknown> = {}): string {
  const [head, , sig] = token.split('.');
  const claims: Record<string, unknown> = { ...payloadOf(token), tenant_id: tenantId, ...extra };
  let pad = 0;
  let out = `${head}.${b64u(JSON.stringify(claims))}.${sig}`;
  if (padTo !== undefined) {
    // "Bearer " plus the token: grow a `pad` claim until the header value is `padTo` bytes.
    const bare = (n: number): string => `${head}.${b64u(JSON.stringify({ ...claims, pad: 'x'.repeat(n) }))}.${sig}`;
    out = bare(0);
    while (7 + out.length < padTo) {
      pad += Math.max(1, Math.floor((padTo - 7 - out.length) * 0.7));
      out = bare(pad);
    }
  }
  return out;
}

/** A token no one signed, whose payload names `tenantId`: the router routes on it, nothing verifies it. */
export function unsignedToken(tenantId: string): string {
  return `${b64u(JSON.stringify({ alg: 'RS256', kid: 'stress' }))}.${b64u(JSON.stringify({ tenant_id: tenantId }))}.${b64u('stress')}`;
}
