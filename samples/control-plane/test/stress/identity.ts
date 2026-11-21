// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The identity calls of the platform run (docs/stress-test.spec.md §3.3 step 4, stress
 * ADR-0017): right after a control-plane tenant's deployment is ACTIVE, this driver creates
 * the tenant in the stress identity (tenant-identity's IAM-signed platform API) with the
 * control-plane tenant id, then its further users, and later deletes it. The calls follow
 * tenant-identity ADR-0037 and ADR-0042: paced at about four a second, repeated with backoff,
 * and a tenant that a throttled `CreateTenant` left without its admin gets its first admin from
 * `CreateUser` with `firstAdmin`, never a blind repeat. Nothing here prints or stores a token,
 * a password or a key; the e-mail addresses are SES simulator addresses.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { type CallResult, type Observer } from './api';
import { sleep } from './aws';
import { type Credentials, loadCredentials } from './edge';
import type { IdentityEntry } from './manifest';

/** One signed HTTP call: the status (0: no answer) and the body text. */
export type Send = (method: string, url: string, body: unknown) => Promise<{ status: number; text: string }>;

/** Calls per second to `CreateTenant` and `CreateUser` (tenant-identity ADR-0042): Cognito's group quota gives out above it. */
export const IDENTITY_CALLS_PER_SECOND = 4;

/** Spaces callers at least 1/ratePerSecond apart, across every caller of one pacer. */
export class Pacer {
  private nextAt = 0;
  constructor(
    private readonly ratePerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async take(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + 1000 / this.ratePerSecond;
    if (at > now) await this.wait(at - now);
  }
}

/** The scope floor the ingress requires on every token (stress ADR-0017). */
const SCOPE = 'app/use';

/** The address of a tenant's n-th user (0: the admin), at the SES mailbox simulator, which no mail reaches. */
export const emailOf = (tenantId: string, n: number): string => `success+${tenantId.toLowerCase()}${n === 0 ? '' : `-u${n}`}@simulator.amazonses.com`;

const jitter = (ms: number): number => Math.min(8000, ms) * (0.5 + Math.random());

/**
 * The identity tenants a sweep deletes (stress ADR-0017): in a platform run, one for every control-plane
 * tenant just deleted (`gone`, with or without an entry: an identity made part way may have none), and one
 * for every entry whose control-plane tenant is in none of `live` (an earlier sweep could not delete it and
 * the tenant is no longer in the manifest to wait for). Slice mode has none.
 */
export function identityTenantsToDelete(
  platform: boolean,
  gone: readonly string[],
  entries: readonly IdentityEntry[],
  live: readonly string[],
): string[] {
  if (!platform) return [];
  const orphans = entries.map((e) => e.tenantId).filter((id) => !live.includes(id));
  return [...new Set([...gone, ...orphans])];
}

export class IdentityApi {
  private readonly base: string;
  private scope?: Promise<boolean>;

  constructor(
    apiUrl: string,
    private readonly send: Send,
    private readonly observe: Observer,
    private readonly pacer: Pacer = new Pacer(IDENTITY_CALLS_PER_SECOND),
    private readonly backoff: (ms: number) => Promise<void> = sleep,
  ) {
    this.base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  }

  /** One call, timed and reported to the observer; a thrown transport failure is status 0. */
  async call(hop: string, method: string, path: string, tenant: string, body?: unknown, expected: readonly number[] = []): Promise<CallResult> {
    const started = process.hrtime.bigint();
    let result: CallResult;
    try {
      const r = await this.send(method, `${this.base}${path}`, body);
      let parsed: unknown;
      try {
        parsed = r.text === '' ? undefined : JSON.parse(r.text);
      } catch {
        parsed = undefined;
      }
      const errorType = r.status >= 400 && typeof (parsed as { __type?: unknown })?.__type === 'string' ? String((parsed as { __type: string }).__type).split('#').pop() : undefined;
      result = { status: r.status, errorType, body: parsed, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
    } catch {
      result = { status: 0, body: undefined, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
    }
    this.observe(hop, result, tenant, expected.includes(result.status));
    return result;
  }

  /**
   * Registers the `app/use` scope in the identity's catalogue when it is not there: `CreateTenant` refuses a
   * scope the catalogue lacks (`invalid_scope`), and a vendor registers it once (a later run reuses it).
   */
  private ensureScope(): Promise<boolean> {
    this.scope ??= (async () => {
      const path = `platform/scopes/${encodeURIComponent(SCOPE)}`;
      const got = await this.again(() => this.call('identity-get-scope', 'GET', path, '-', undefined, [404]), (s) => s === 0 || s === 429 || s === 503);
      if (got.status === 200) return true;
      if (got.status !== 404) return false;
      const put = await this.again(() => this.call('identity-put-scope', 'PUT', path, '-', { description: 'platform stress test' }), (s) => s === 0 || s === 429 || s === 503);
      return put.status === 200;
    })();
    return this.scope;
  }

  /** A paced write: `CreateTenant` and `CreateUser` count against the same Cognito quota. */
  private async paced(hop: string, method: string, path: string, tenant: string,
    body: unknown, expected: readonly number[] = []): Promise<CallResult> {
    await this.pacer.take();
    return this.call(hop, method, path, tenant, body, expected);
  }

  private async again(call: () => Promise<CallResult>, retry: (status: number) => boolean, attempts = 12): Promise<CallResult> {
    let r = await call();
    for (let attempt = 1; attempt < attempts && retry(r.status); attempt += 1) {
      await this.backoff(jitter(400 * 2 ** attempt));
      r = await call();
    }
    return r;
  }

  /** A user's name by e-mail address, from the tenant's user list. */
  private async findUser(tenantId: string, email: string): Promise<string | undefined> {
    let token: string | undefined;
    do {
      const query = token === undefined ? '' : `?nextToken=${encodeURIComponent(token)}`;
      const page = await this.again(() => this.call('identity-list-users', 'GET', `platform/tenants/${tenantId}/users${query}`, tenantId), (s) => s === 0 || s === 429 || s === 503);
      if (page.status !== 200) return undefined;
      const users = (page.body?.users ?? []) as { username?: string; email?: string }[];
      const found = users.find((u) => u.email === email);
      if (found?.username !== undefined) return found.username;
      token = typeof page.body?.nextToken === 'string' ? page.body.nextToken : undefined;
    } while (token !== undefined);
    return undefined;
  }

  /**
   * Creates one user. A 409 means the e-mail address is already there (an earlier attempt that
   * timed out): the user is looked up instead. Returns the user name.
   */
  async createUser(tenantId: string, email: string, firstAdmin = false): Promise<string | undefined> {
    const body = firstAdmin ? { email, firstAdmin: true } : { email };
    const r = await this.again(
      () => this.paced('identity-create-user', 'POST', `platform/tenants/${tenantId}/users`, tenantId, body, [409]),
      (s) => s === 0 || s === 429 || s === 503,
    );
    if (r.status === 201) return typeof r.body?.user?.username === 'string' ? r.body.user.username : undefined;
    if (r.status === 409) return this.findUser(tenantId, email);
    return undefined;
  }

  /**
   * Creates the tenant under the control-plane tenant id with its first admin. A 503 may have
   * created the tenant without its admin (tenant-identity ADR-0037), so the recovery reads the
   * tenant and, when it is ACTIVE, claims the first-admin slot with `CreateUser`; a 404 means
   * nothing was written, or the create compensated, so the create is repeated.
   */
  async createTenant(tenantId: string, name: string): Promise<string | undefined> {
    const adminEmail = emailOf(tenantId, 0);
    if (!(await this.ensureScope())) return undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const r = await this.paced('identity-create-tenant', 'POST', 'platform/tenants', tenantId, { tenantId, name, adminEmail, scopes: [SCOPE] }, [409, 503]);
      if (r.status === 201) return typeof r.body?.admin?.user?.username === 'string' ? r.body.admin.user.username : undefined;
      if (r.status === 429) {
        await this.backoff(jitter(400 * 2 ** attempt));
        continue;
      }
      if (r.status === 409 || r.status === 503 || r.status === 0) {
        const t = await this.again(() => this.call('identity-get-tenant', 'GET', `platform/tenants/${tenantId}`, tenantId, undefined, [404]), (s) => s === 0 || s === 429 || s === 503);
        if (t.status === 200 && t.body?.tenant?.status === 'ACTIVE') return this.createUser(tenantId, adminEmail, true);
        await this.backoff(jitter(400 * 2 ** attempt));
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** The tenant and its `users` further users, recorded as an `identity[]` entry; undefined when any step failed. */
  async createIdentity(tenantId: string, name: string, users: number, save?: (entry: IdentityEntry) => void): Promise<IdentityEntry | undefined> {
    const admin = await this.createTenant(tenantId, name);
    if (admin === undefined) return undefined;
    const entry: IdentityEntry = { tenantId, admin: { username: admin, email: emailOf(tenantId, 0) }, users: [] };
    // `save` runs once the tenant exists and after each user, so a failure part way leaves an entry the sweep deletes.
    save?.(entry);
    for (let n = 1; n <= users; n += 1) {
      const username = await this.createUser(tenantId, emailOf(tenantId, n));
      if (username === undefined) return undefined;
      (entry.users as { username: string; email: string }[]).push({ username, email: emailOf(tenantId, n) });
      save?.(entry);
    }
    return entry;
  }

  /** IssueToken (a test aid of tenant-identity): sets the user's password and returns an access token, kept in memory. */
  async issueToken(tenantId: string, username: string): Promise<string | undefined> {
    const password = `Aa1!${randomBytes(18).toString('base64url')}`;
    const r = await this.again(
      () => this.call('identity-issue-token', 'POST', `platform/tenants/${tenantId}/users/${encodeURIComponent(username)}/token`, tenantId, { password }),
      (s) => s === 0 || s === 429 || s === 503,
      6,
    );
    return r.status === 200 && typeof r.body?.accessToken === 'string' ? r.body.accessToken : undefined;
  }

  /** DeleteTenant until 204 or 404 (it resumes where it stopped). True when the tenant is gone. */
  async deleteTenant(tenantId: string): Promise<boolean> {
    const r = await this.again(() => this.call('identity-delete-tenant', 'DELETE', `platform/tenants/${tenantId}`, tenantId, undefined, [404]), (s) => s === 0 || s === 429 || s === 503 || s === 504, 8);
    return r.status === 204 || r.status === 404;
  }
}

/**
 * A `Send` that signs with the run's own AWS credentials (SigV4, `execute-api`) through curl
 * 7.75 or later. The key pair and every body (a user name, an e-mail address, the password of
 * IssueToken) reach curl on stdin as a `--config -` file, never in argv.
 */
export function curlSend(region: string, load: () => Promise<{ creds: Credentials; expiresAt: number } | undefined> = loadCredentials, curl = 'curl', now: () => number = Date.now): Send {
  let cached: { creds: Credentials; expiresAt: number } | undefined;
  return async (method, url, body) => {
    if (cached === undefined || cached.expiresAt - now() < 60_000) cached = await load();
    if (cached === undefined) return { status: 0, text: '' };
    const { creds } = cached;
    const lines = [`user = "${creds.accessKeyId}:${creds.secretAccessKey}"`];
    if (creds.sessionToken !== undefined) lines.push(`header = "x-amz-security-token: ${creds.sessionToken}"`);
    if (body !== undefined) {
      lines.push('header = "content-type: application/json"');
      lines.push(`data-raw = ${JSON.stringify(JSON.stringify(body))}`);
    }
    const args = ['-sS', '--max-time', '30', '-X', method, '--aws-sigv4', `aws:amz:${region}:execute-api`, '--config', '-', '-w', '\n%{http_code}', url];
    return new Promise((resolve) => {
      const child = execFile(curl, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        const at = stdout.lastIndexOf('\n');
        const code = at < 0 ? '' : stdout.slice(at + 1).trim();
        if (error !== null && !/^\d{3}$/.test(code)) resolve({ status: 0, text: '' });
        else resolve({ status: /^\d{3}$/.test(code) ? Number(code) : 0, text: at < 0 ? '' : stdout.slice(0, at) });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${lines.join('\n')}\n`);
    });
  };
}
