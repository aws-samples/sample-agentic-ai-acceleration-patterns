// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The control-plane API as the stress slice calls it: an operator ID token from the slice's
 * vendor IdP, kept in memory only, and one timed HTTP call per request. Every call reports
 * its hop, status, reason and seconds to an observer, attributed to the tenant it is for
 * (P-7), and prints nothing.
 */

import { randomBytes } from 'node:crypto';
import { aws, AwsError } from './aws';

export interface CallResult {
  readonly status: number;
  /** The Smithy error type (`x-amzn-errortype`) of a refusal, e.g. `InsufficientCapacityError`. */
  readonly errorType?: string;
  readonly body: any;
  readonly seconds: number;
}

/**
 * Receives every call: `tenant` is the tenant id it is for, or `-` for a fleet-wide read;
 * `expected` is true when the caller asked for this status (a 404 while it waits for a
 * delete, a 409 a placement race must give), so it is no refusal.
 */
export type Observer = (hop: string, result: CallResult, tenant: string, expected: boolean) => void;

/** `InsufficientCapacityError` -> `insufficient-capacity`; a status word when there is no type. */
export function reasonOf(status: number, errorType?: string): string {
  if (errorType !== undefined && /^[A-Za-z]{1,64}$/.test(errorType)) {
    return errorType.replace(/Error$|Exception$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }
  switch (status) {
    case 0: return 'network';
    case 400: return 'bad-request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 409: return 'conflict';
    case 429: return 'throttled';
    default: return status >= 500 ? 'server-error' : 'refused';
  }
}

/** A password Cognito's default policy accepts: upper, lower, digit and symbol, 32 characters. */
function password(): string {
  return `Aa1!${randomBytes(21).toString('base64url')}`.slice(0, 32);
}

/**
 * Signs the slice's operator in to the vendor IdP: creates `stress-operator` once, sets a
 * fresh random password, and returns the ID token. The password reaches the CLI as input
 * JSON in a memory-backed file (`aws`), the token comes back in memory; neither is printed.
 */
export async function operatorToken(userPoolId: string, clientId: string): Promise<string> {
  const username = 'stress-operator';
  try {
    await aws(['cognito-idp', 'admin-create-user', ], {
      input: { UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS' },
    });
  } catch (e) {
    if (!(e instanceof AwsError) || e.errorName !== 'UsernameExistsException') throw e;
  }
  const secret = password();
  await aws(['cognito-idp', 'admin-set-user-password', ], {
    input: { UserPoolId: userPoolId, Username: username, Password: secret, Permanent: true },
  });
  const out = await aws(['cognito-idp', 'admin-initiate-auth', ], {
    input: { UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: secret } },
  });
  const token = out?.AuthenticationResult?.IdToken;
  if (typeof token !== 'string') throw new Error('the vendor IdP returned no ID token');
  return token;
}

export class ControlPlaneApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly observe: Observer,
    private readonly timeoutMs = 30_000,
  ) {}

  /** One call. Never throws on an HTTP status; a transport failure is status 0. */
  async call(hop: string, method: string, path: string, tenant: string, body?: unknown, expected: readonly number[] = []): Promise<CallResult> {
    const started = process.hrtime.bigint();
    let result: CallResult;
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'authorization': `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = undefined;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const errorType = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? undefined;
      result = { status: res.status, errorType: res.ok ? undefined : errorType, body: parsed, seconds: elapsed(started) };
    } catch {
      result = { status: 0, body: undefined, seconds: elapsed(started) };
    }
    this.observe(hop, result, tenant, expected.includes(result.status));
    return result;
  }

  /** Every page of a list operation, from `path` (with its query) and the item field. */
  async listAll(hop: string, path: string, field: string, tenant = '-'): Promise<{ items: any[]; status: number }> {
    const items: any[] = [];
    let next: string | undefined;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.call(hop, 'GET', next === undefined ? path : `${path}${sep}nextToken=${encodeURIComponent(next)}`, tenant);
      if (page.status !== 200) return { items, status: page.status };
      items.push(...((page.body?.[field] as any[]) ?? []));
      next = page.body?.nextToken;
    } while (next !== undefined);
    return { items, status: 200 };
  }
}

function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e9;
}
