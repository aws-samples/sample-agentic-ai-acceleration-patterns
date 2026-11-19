// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { refuse } from './errors';
import { parseCreatedAt, toControlPlaneId } from '../shared/route-table';

/**
 * The control-plane reads the registrar makes on every write that sets
 * placement (spec §3.4 step 2; the edge operator role's deletes and status
 * changes skip them, ADR-0025): `GetCell`, `GetDeployment` and `GetTenant`, with a
 * client-credentials reader token from the vendor IdP (ADR-0015, spike
 * S-9, control-plane R-36 and R-38). Any read that does not give a usable
 * answer throws a 503: the write is refused, never made unchecked.
 */

/** Lifecycle status of a cell or deployment (control-plane §4.2). */
export type LifecycleStatus = 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING' | 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED';

const STATUSES: readonly string[] = ['CREATING', 'ACTIVE', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'];
const ACCOUNT = /^\d{12}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface CellRecord {
  readonly applicationId: string;
  readonly accountId: string;
  readonly status: LifecycleStatus;
}

export interface DeploymentRecord {
  readonly applicationId: string;
  /** Upper case, as the control plane names it. */
  readonly cellId: string;
  readonly accountId: string;
  readonly status: LifecycleStatus;
  /** `createdAt` as Unix ms (spec §4.1); a value that does not parse is a 503. */
  readonly dt: number;
}

export interface TenantRecord {
  readonly name: string;
}

/** What the registrar reads. `undefined` is a missing record (404). */
export interface ControlPlane {
  getCell(cellId: string): Promise<CellRecord | undefined>;
  getDeployment(tenantId: string, applicationId: string): Promise<DeploymentRecord | undefined>;
  getTenant(tenantId: string): Promise<TenantRecord | undefined>;
}

export interface ControlPlaneReaderOptions {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly secretArn: string;
  readonly secrets: SecretsManagerClient;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Refetch the token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

/** Each control-plane or token call is abandoned after this long, inside the function's 30 s. */
const CALL_TIMEOUT_MS = 3_000;

const UNREADABLE = 'the control plane cannot be read; retry';

function unreadable(): Error {
  return refuse.unavailable(UNREADABLE);
}

/** Releases the connection of a response whose body is not read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

function object(x: unknown): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw unreadable();
  return x as Record<string, unknown>;
}

function string(o: Record<string, unknown>, k: string, rule?: RegExp): string {
  const x = o[k];
  if (typeof x !== 'string' || (rule !== undefined && !rule.test(x))) throw unreadable();
  return x;
}

function status(o: Record<string, unknown>): LifecycleStatus {
  const s = string(o, 'status');
  if (!STATUSES.includes(s)) throw unreadable();
  return s as LifecycleStatus;
}

export class ControlPlaneReader implements ControlPlane {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private token?: { readonly value: string; readonly refreshAt: number };
  private pending?: Promise<string>;
  private secret?: string;

  constructor(private readonly options: ControlPlaneReaderOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getCell(cellId: string): Promise<CellRecord | undefined> {
    const body = await this.get(`/cells/${encodeURIComponent(toControlPlaneId(cellId))}`);
    if (body === undefined) return undefined;
    const cell = object(object(body).cell);
    return { applicationId: string(cell, 'applicationId'), accountId: string(cell, 'accountId', ACCOUNT), status: status(cell) };
  }

  async getDeployment(tenantId: string, applicationId: string): Promise<DeploymentRecord | undefined> {
    const path = `/tenants/${encodeURIComponent(toControlPlaneId(tenantId))}/deployments/${encodeURIComponent(applicationId)}`;
    const body = await this.get(path);
    if (body === undefined) return undefined;
    const o = object(body);
    const deployment = object(o.deployment);
    const dt = parseCreatedAt(deployment.createdAt);
    if (dt === undefined) throw refuse.unavailable('the control plane returned a createdAt that does not parse; retry');
    return {
      applicationId: string(deployment, 'applicationId'),
      cellId: string(deployment, 'cellId', ULID),
      accountId: string(o, 'accountId', ACCOUNT),
      status: status(deployment),
      dt,
    };
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const body = await this.get(`/tenants/${encodeURIComponent(toControlPlaneId(tenantId))}`);
    if (body === undefined) return undefined;
    return { name: string(object(object(body).tenant), 'name') };
  }

  /**
   * GET with the reader token. 200 is the body; a 404 the control plane's
   * service answered (`x-amzn-errortype: ResourceNotFoundError`) is a
   * missing record. A 401 or 403 drops the cached token and tries once more
   * with a new one. Anything else is a 503.
   */
  private async get(path: string, retried = false): Promise<unknown> {
    const token = await this.readerToken();
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw unreadable();
    }
    if (response.status === 200) {
      try {
        return await response.json();
      } catch {
        throw unreadable();
      }
    }
    await discard(response);
    if (response.status === 404 && (response.headers.get('x-amzn-errortype') ?? '').startsWith('ResourceNotFoundError')) {
      return undefined;
    }
    if ((response.status === 401 || response.status === 403) && !retried) {
      this.token = undefined;
      return this.get(path, true);
    }
    throw unreadable();
  }

  /** The cached reader token, fetched again shortly before it expires. Concurrent callers share one fetch. */
  private async readerToken(): Promise<string> {
    if (this.token !== undefined && this.now() < this.token.refreshAt) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const secret = await this.clientSecret();
    const basic = Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
    let response: Response;
    try {
      response = await this.fetch(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'authorization': `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw unreadable();
    }
    if (response.status !== 200) {
      await discard(response);
      // A rotated secret is read again on the next call.
      this.secret = undefined;
      throw unreadable();
    }
    let body: Record<string, unknown>;
    try {
      body = object(await response.json());
    } catch {
      throw unreadable();
    }
    const value = body.access_token;
    const expiresIn = body.expires_in;
    if (typeof value !== 'string' || value === '' || typeof expiresIn !== 'number' || !(expiresIn > 0)) throw unreadable();
    const lifetime = expiresIn * 1000;
    // A token that lives less than twice the margin is used for half its life.
    const margin = Math.min(TOKEN_MARGIN_MS, lifetime / 2);
    this.token = { value, refreshAt: this.now() + lifetime - margin };
    return value;
  }

  /** The client secret, read once per environment. */
  private async clientSecret(): Promise<string> {
    if (this.secret !== undefined) return this.secret;
    let value: string | undefined;
    try {
      value = (await this.options.secrets.send(new GetSecretValueCommand({ SecretId: this.options.secretArn }))).SecretString;
    } catch {
      throw unreadable();
    }
    if (value === undefined || value === '') throw unreadable();
    this.secret = value;
    return value;
  }
}
