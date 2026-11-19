// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Runs `src/router/router.js` in Node the way CloudFront runs it: the
 * source with its build tokens substituted (as the stack does), its two
 * imports bound to a fake `cloudfront` module and Node's `crypto`, and a
 * fixed clock. The fake KeyValueStore is a Map loaded from
 * `test/fixtures/route-table.json`; `get` rejects for a missing key, as
 * `cf.kvs().get` does.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { RouterTokenValues, substituteRouterTokens, TENANT_CLAIM } from '../../src/shared/contracts';
import { RESERVED_LABELS } from '../../src/shared/route-table';

export const ROUTER_PATH = path.join(__dirname, '../../src/router/router.js');
const FIXTURES = path.join(__dirname, '../fixtures');

export const readFixture = (f: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));

export const SINGLE_DOMAIN = 'app.example.com';
export const HOST_DOMAIN = 'tenants.example.com';
/** `signin-state.json`'s clock, Unix seconds. */
export const NOW = readFixture('signin-state.json').nowSeconds as number;

export const T_ACME = '01hzx8k9p0qrst7vwxyz1a2b3c';
export const T_DEDICATED = '01hzx8k9p0qrst7vwxyz1a2b3e';
export const T_SUSPENDED = '01hzx8k9p0qrst7vwxyz1a2b3f';
export const T_NO_HOST = '01hzx8k9p0qrst7vwxyz1a2b3g';
export const CELL_ORIGIN = 'abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-central-1.on.aws';
export const ACME_HOST = `${T_ACME}.${HOST_DOMAIN}`;
export const DEDICATED_HOST = 'portal.example.com';

export function tokenValues(over: Partial<RouterTokenValues> = {}): RouterTokenValues {
  return {
    appDomain: SINGLE_DOMAIN,
    addressing: 'single',
    tenantClaim: TENANT_CLAIM,
    agentIngress: 'on',
    reservedLabels: RESERVED_LABELS.join(','),
    ...over,
  };
}

/** The router source after the stack's substitution. */
export function substitutedSource(values: RouterTokenValues): string {
  return substituteRouterTokens(fs.readFileSync(ROUTER_PATH, 'utf8'), values);
}

const IMPORT_CF = "import cf from 'cloudfront';";
const IMPORT_CRYPTO = "import crypto from 'crypto';";

export interface Header {
  value: string;
  multiValue?: { value: string }[];
}

export interface RouterEvent {
  version: string;
  context: Record<string, string>;
  viewer: { ip: string };
  request: {
    method: string;
    uri: string;
    querystring: Record<string, Header>;
    headers: Record<string, Header>;
    cookies: Record<string, Header>;
  };
}

export interface Answer {
  statusCode?: number;
  headers: Record<string, Header>;
  body?: { encoding: string; data: string };
  uri?: string;
  querystring?: Record<string, Header>;
}

export interface Router {
  /** The fake store; tests add or delete keys. */
  readonly store: Map<string, string>;
  /** Keys read, per run. */
  readonly reads: string[];
  readonly origins: unknown[];
  readonly logs: string[];
  run(e: RouterEvent): Promise<Answer>;
}

/** The route table fixture as a Map, key to value. */
export function fixtureStore(): Map<string, string> {
  const rt: { valid: { key: string; value: string }[] } = readFixture('route-table.json');
  return new Map(rt.valid.map((e) => [e.key, e.value]));
}

export function loadRouter(values: RouterTokenValues, nowSeconds: number = NOW): Router {
  let source = substitutedSource(values);
  for (const line of [IMPORT_CF, IMPORT_CRYPTO]) {
    if (!source.includes(line)) throw new Error(`router has no ${line}`);
  }
  source = source.replace(IMPORT_CF, 'const cf = __cf;').replace(IMPORT_CRYPTO, 'const crypto = __crypto;');
  if (/\b(import|export|require)\b/.test(source)) throw new Error('router uses a module outside cloudfront and crypto');

  const store = fixtureStore();
  const reads: string[] = [];
  const origins: unknown[] = [];
  const logs: string[] = [];
  const fakeCf = {
    kvs: () => ({
      get: async (key: string): Promise<string> => {
        reads.push(key);
        const v = store.get(key);
        if (v === undefined) throw new Error(`Key ${key} not found`);
        return v;
      },
    }),
    updateRequestOrigin: (o: unknown) => origins.push(o),
    logCustomData: (s: string) => logs.push(s),
  };
  const context = vm.createContext({
    __cf: fakeCf,
    __crypto: crypto,
    Buffer,
    Date: { now: () => nowSeconds * 1000 },
  });
  const handler = vm.runInContext(`${source}\n;handler`, context, { filename: 'router.js' }) as (e: RouterEvent) => Promise<Answer>;
  return {
    store,
    reads,
    origins,
    logs,
    run: async (e) => {
      reads.length = 0;
      origins.length = 0;
      logs.length = 0;
      // Round-trip through JSON, as CloudFront hands the function plain data.
      return JSON.parse(JSON.stringify(await handler(e)));
    },
  };
}

export interface RequestSpec {
  host: string;
  uri: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  token?: string;
}

export function event(r: RequestSpec): RouterEvent {
  const headers: Record<string, Header> = { host: { value: r.host } };
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = { value: v };
  if (r.token !== undefined) headers.authorization = { value: `Bearer ${r.token}` };
  const querystring: Record<string, Header> = {};
  for (const [k, v] of Object.entries(r.query ?? {})) {
    querystring[k] = Array.isArray(v) ? { value: v[0], multiValue: v.map((value) => ({ value })) } : { value: v };
  }
  return {
    version: '1.0',
    context: { endpoint: 'd111111abcdef8.cloudfront.net', eventType: 'viewer-request' },
    viewer: { ip: '198.51.100.11' },
    request: { method: r.method ?? 'GET', uri: r.uri, querystring, headers, cookies: {} },
  };
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** An unsigned JWT-shaped token with the given payload; the router never checks the signature. */
export function token(payload: Record<string, unknown>, signature = 'c2lnbmF0dXJl'): string {
  return `${b64url('{"alg":"RS256","typ":"JWT"}')}.${b64url(JSON.stringify(payload))}.${signature}`;
}

export const tokenFor = (tenantId: string): string => token({ sub: 'user-1', tenant_id: tenantId });

/** The answer's header value, or undefined. */
export const header = (a: Answer, name: string): string | undefined => a.headers?.[name]?.value;
