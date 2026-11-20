// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { refuse } from './errors';
import { logLine } from './log';
import { parseCreatedAt, toControlPlaneId } from '../shared/route-table';

/**
 * The control-plane reads the registrar makes on every write that sets
 * placement (spec §3.4 step 2; the edge operator role's deletes and status
 * changes skip them, ADR-0025): `GetCell`, `GetDeployment` and `GetTenant`, with a
 * client-credentials reader token from the vendor IdP (ADR-0015, spike
 * S-9, control-plane R-36 and R-38). Any read that does not give a usable
 * answer throws a 503: the write is refused, never made unchecked. A read
 * that times out or gets a 5xx or a network error is tried once more after
 * a short jittered pause, inside one time budget (spec §3.4 step 2).
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
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Refetch the token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

/** Each secret, token or control-plane call is abandoned after this long, or sooner when the read's budget runs out. */
const CALL_TIMEOUT_MS = 3_000;

/**
 * One read, its token and secret calls and its one retry included, ends
 * within this long, so the reads of a write (made at once, not one after
 * the other) leave most of the function's 30 s and API Gateway's 29 s to
 * the store write. The worst case is exactly this, because every call's
 * limit is cut to what is left of it, and a retry starts only when the
 * longest pause plus 1 s is still left.
 */
export const READ_BUDGET_MS = 10_000;

/** The pause before the retry: a random time between these. */
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 400;

/** No retry starts with less than this left of the budget. */
const MIN_RETRY_MS = 1_000;

const UNREADABLE = 'the control plane cannot be read; retry';

function unreadable(): Error {
  return refuse.unavailable(UNREADABLE);
}

/** The control-plane calls a read is made of; the name goes in the log line. */
type Call = 'GetSecretValue' | 'FetchReaderToken' | 'GetCell' | 'GetDeployment' | 'GetTenant';

/**
 * A call that gave no usable answer. `why` is an error class or `HTTP <status>`,
 * never a message, a URL or a value. `transient` is a timeout, a network
 * error or a 5xx: the read is tried once more. `auth` is a 401 or 403 on the
 * control plane: the token is fetched again.
 */
class CallFailed extends Error {
  constructor(readonly call: Call, readonly why: string, readonly transient: boolean, readonly auth = false) {
    super(`${call}: ${why}`);
  }
}

function errorClass(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : typeof error;
}

/** A 5xx. */
function serverError(code: number): boolean {
  return code >= 500 && code <= 599;
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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ControlPlaneReaderOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async getCell(cellId: string): Promise<CellRecord | undefined> {
    const body = await this.get('GetCell', `/cells/${encodeURIComponent(toControlPlaneId(cellId))}`);
    if (body === undefined) return undefined;
    const cell = object(object(body).cell);
    return { applicationId: string(cell, 'applicationId'), accountId: string(cell, 'accountId', ACCOUNT), status: status(cell) };
  }

  async getDeployment(tenantId: string, applicationId: string): Promise<DeploymentRecord | undefined> {
    const path = `/tenants/${encodeURIComponent(toControlPlaneId(tenantId))}/deployments/${encodeURIComponent(applicationId)}`;
    const body = await this.get('GetDeployment', path);
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
    const body = await this.get('GetTenant', `/tenants/${encodeURIComponent(toControlPlaneId(tenantId))}`);
    if (body === undefined) return undefined;
    return { name: string(object(object(body).tenant), 'name') };
  }

  /**
   * One read (spec §3.4 step 2): GET with the reader token, inside the
   * `READ_BUDGET_MS` budget. 200 is the body; a 404 the control plane's
   * service answered (`x-amzn-errortype: ResourceNotFoundError`) is a
   * missing record and is not tried again. A 401 or 403 drops the cached
   * token and tries once more with a new one. A call that times out, fails
   * on the network or gets a 5xx (the secret, the token or the read itself)
   * is tried once more after a short jittered pause. Every other answer, and
   * the second failure, is a 503.
   */
  private async get(call: 'GetCell' | 'GetDeployment' | 'GetTenant', path: string): Promise<unknown> {
    const deadline = this.now() + READ_BUDGET_MS;
    let refreshed = false;
    let retried = false;
    for (;;) {
      try {
        return await this.attempt(call, path, deadline);
      } catch (error) {
        if (!(error instanceof CallFailed)) throw error;
        const refresh = error.auth && !refreshed;
        const retry = error.transient && !retried && deadline - this.now() >= BACKOFF_MAX_MS + MIN_RETRY_MS;
        logLine(refresh || retry ? 'WARN' : 'ERROR', 'control-plane read failed', {
          read: call,
          call: error.call,
          error: error.why.startsWith('HTTP ') ? undefined : error.why,
          status: error.why.startsWith('HTTP ') ? Number(error.why.slice(5)) : undefined,
          retrying: refresh || retry,
        });
        if (refresh) {
          refreshed = true;
          this.token = undefined;
        } else if (retry) {
          retried = true;
          await this.sleep(BACKOFF_MIN_MS + this.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS));
        } else {
          throw unreadable();
        }
      }
    }
  }

  /** The time one call may take: its own limit, or what is left of the read's budget. */
  private callLimit(call: Call, deadline: number): number {
    const left = deadline - this.now();
    if (left <= 0) throw new CallFailed(call, 'BudgetExhausted', false);
    return Math.min(CALL_TIMEOUT_MS, left);
  }

  private async attempt(call: 'GetCell' | 'GetDeployment' | 'GetTenant', path: string, deadline: number): Promise<unknown> {
    const token = await this.readerToken(deadline);
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.callLimit(call, deadline)),
      });
    } catch (error) {
      if (error instanceof CallFailed) throw error;
      throw new CallFailed(call, errorClass(error), true);
    }
    if (response.status === 200) {
      try {
        return await response.json();
      } catch (error) {
        // A body that is not JSON is the control plane's answer; one that ended early is the network's.
        throw new CallFailed(call, errorClass(error), errorClass(error) !== 'SyntaxError');
      }
    }
    await discard(response);
    if (response.status === 404 && (response.headers.get('x-amzn-errortype') ?? '').startsWith('ResourceNotFoundError')) {
      return undefined;
    }
    throw new CallFailed(call, `HTTP ${response.status}`, serverError(response.status), response.status === 401 || response.status === 403);
  }

  /** The cached reader token, fetched again shortly before it expires. Concurrent callers share one fetch. */
  private async readerToken(deadline: number): Promise<string> {
    if (this.token !== undefined && this.now() < this.token.refreshAt) return this.token.value;
    this.pending ??= this.fetchToken(deadline).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchToken(deadline: number): Promise<string> {
    const secret = await this.clientSecret(deadline);
    const basic = Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
    const call = 'FetchReaderToken';
    let response: Response;
    try {
      response = await this.fetch(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'authorization': `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.callLimit(call, deadline)),
      });
    } catch (error) {
      if (error instanceof CallFailed) throw error;
      throw new CallFailed(call, errorClass(error), true);
    }
    if (response.status !== 200) {
      await discard(response);
      // A rotated secret is read again on the next call.
      if (!serverError(response.status)) this.secret = undefined;
      throw new CallFailed(call, `HTTP ${response.status}`, serverError(response.status));
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CallFailed(call, errorClass(error), errorClass(error) !== 'SyntaxError');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new CallFailed(call, 'UnusableToken', false);
    const body = json as Record<string, unknown>;
    const value = body.access_token;
    const expiresIn = body.expires_in;
    if (typeof value !== 'string' || value === '' || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      throw new CallFailed(call, 'UnusableToken', false);
    }
    const lifetime = expiresIn * 1000;
    // A token that lives less than twice the margin is used for half its life.
    const margin = Math.min(TOKEN_MARGIN_MS, lifetime / 2);
    this.token = { value, refreshAt: this.now() + lifetime - margin };
    return value;
  }

  /** The client secret, read once per environment. */
  private async clientSecret(deadline: number): Promise<string> {
    if (this.secret !== undefined) return this.secret;
    const call = 'GetSecretValue';
    let value: string | undefined;
    try {
      const abortSignal = AbortSignal.timeout(this.callLimit(call, deadline));
      value = (await this.options.secrets.send(new GetSecretValueCommand({ SecretId: this.options.secretArn }), { abortSignal })).SecretString;
    } catch (error) {
      if (error instanceof CallFailed) throw error;
      // The SDK's own answer carries the HTTP status; a 4xx (access denied, no such secret) is not tried again.
      const code = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
      throw new CallFailed(call, errorClass(error), code === undefined || serverError(code));
    }
    if (value === undefined || value === '') throw new CallFailed(call, 'EmptySecret', false);
    this.secret = value;
    return value;
  }
}
