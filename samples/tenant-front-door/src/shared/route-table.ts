// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The route table contract (spec §4.1): every KeyValueStore key and value
 * the registrar, the stack's custom resources and the sweeper write, and
 * that the router reads. The router is a CloudFront Function and cannot
 * import this module, so `test/fixtures/route-table.json` holds golden
 * entries that both this codec and the router's own parser are tested
 * against.
 *
 * Values are compact JSON of at most 1 KB, always with `"v": 1`. Ids are
 * stored lower-case (§4.1); the control plane's upper-case ULID form is
 * restored only to call the control plane and in `/config.json`.
 */

/** The value schema version every entry carries. */
export const ROUTE_TABLE_VERSION = 1;

/** KeyValueStore's limit for one value (§4.1). */
export const MAX_VALUE_BYTES = 1024;

/** KeyValueStore's limit for the whole store (ADR-0012). */
export const MAX_STORE_BYTES = 5 * 1024 * 1024;

/** The registrar's alarm and stated ceilings sit at 80 % of 5 MB (§4.1, ADR-0012). */
export const STORE_ALARM_BYTES = 4_000_000;

/** Host labels refused at registration (§4.1). */
export const RESERVED_LABELS: readonly string[] = ['www', 'api', 'admin', 'auth', 'login', 'static', 'status'];

/** The display name's byte cap once sanitised (§4.1). */
export const MAX_DISPLAY_NAME_BYTES = 64;

/** A stored tenant id: one DNS label, lower case (§4.1). */
const STORED_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A control-plane ULID (cell or tenant), either case. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const KEY_APP = 'app';
export const KEY_SIGNIN = 'signin';

export function tenantKey(tenantId: string): string {
  return `tenant#${toStoredId(tenantId)}`;
}

export function cellKey(cellId: string): string {
  return `cell#${toStoredId(cellId)}`;
}

export function hostKey(host: string): string {
  return `host#${host.toLowerCase()}`;
}

/** Lower-cases an id and checks it is one DNS label (§4.1). Throws otherwise. */
export function toStoredId(id: string): string {
  const stored = id.toLowerCase();
  if (!STORED_ID.test(stored)) {
    throw new RouteTableError(`not a valid route id: ${JSON.stringify(id)}`);
  }
  return stored;
}

/** The control plane's form of a stored ULID id: upper case (§4.1). */
export function toControlPlaneId(storedId: string): string {
  if (!ULID.test(storedId)) {
    throw new RouteTableError(`not a control-plane ULID: ${JSON.stringify(storedId)}`);
  }
  return storedId.toUpperCase();
}

/** True when the first label of a host is reserved (§4.1). */
export function isReservedLabel(label: string): boolean {
  return RESERVED_LABELS.includes(label.toLowerCase());
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type RouteStatus = 'active' | 'suspended';

/** `tenant#<tenantId>`. */
export interface TenantEntry {
  readonly v: 1;
  /** Cell id, lower case. */
  readonly c: string;
  /** Account the control plane placed the deployment in. */
  readonly ac: string;
  /** Deployment `createdAt`, Unix ms. */
  readonly dt: number;
  readonly s: RouteStatus;
  /** Sanitised display name (`sanitiseDisplayName`). */
  readonly n: string;
  /** Dedicated domain, only when the edge operator role set one. */
  readonly d?: string;
  /** Domain challenge token, 43 base64url characters, with `d` until the challenge passes. */
  readonly dk?: string;
  /** Challenge expiry, Unix seconds, only while the challenge is open. */
  readonly dx?: number;
}

/** `host#<host>`. */
export interface HostEntry {
  readonly v: 1;
  /** Tenant id, lower case. */
  readonly t: string;
  readonly ac: string;
}

/** `cell#<cellId>`. */
export interface CellEntry {
  readonly v: 1;
  readonly ac: string;
  /** The cell's API origin host. */
  readonly o: string;
}

/** `app`: the SPA's public issuer settings (§3.6). */
export interface AppEntry {
  readonly v: 1;
  /** Authorize endpoint. */
  readonly az: string;
  /** Token endpoint. */
  readonly tk: string;
  /** Client id. */
  readonly cid: string;
  /** Scopes, space-separated. */
  readonly sc: string;
  /** Logout endpoint. */
  readonly lo: string;
  /** Exchange endpoint, only when `exchangeEndpoint` is set (§3.5). */
  readonly ex?: string;
}

/** `signin`: `host` mode only (ADR-0016). */
export interface SigninEntry {
  readonly v: 1;
  /** The key id that signs. */
  readonly cur: string;
  /** Key id (at most 8 of `[a-z0-9]`) to base64 32-byte key. */
  readonly k: Readonly<Record<string, string>>;
}

export class RouteTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteTableError';
  }
}

/**
 * Encodes an entry as compact JSON in the order the type lists its fields,
 * leaving out absent optional fields, and checks the 1 KB limit.
 */
export function encodeEntry(entry: TenantEntry | HostEntry | CellEntry | AppEntry | SigninEntry): string {
  const value = JSON.stringify(entry);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new RouteTableError(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  return value;
}

/** Builds a `tenant#` value with its fields in the §4.1 order. */
export function tenantEntry(fields: Omit<TenantEntry, 'v'>): TenantEntry {
  const e: Record<string, unknown> = { v: 1, c: fields.c, ac: fields.ac, dt: fields.dt, s: fields.s, n: fields.n };
  if (fields.d !== undefined) e.d = fields.d;
  if (fields.dk !== undefined) e.dk = fields.dk;
  if (fields.dx !== undefined) e.dx = fields.dx;
  return e as unknown as TenantEntry;
}

function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RouteTableError('value is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RouteTableError('value is not an object');
  }
  const o = parsed as Record<string, unknown>;
  if (o.v !== ROUTE_TABLE_VERSION) {
    throw new RouteTableError(`unknown value version ${JSON.stringify(o.v)}`);
  }
  return o;
}

function str(o: Record<string, unknown>, k: string, optional = false): string | undefined {
  const x = o[k];
  if (x === undefined && optional) return undefined;
  if (typeof x !== 'string') throw new RouteTableError(`field ${k} is not a string`);
  return x;
}

function int(o: Record<string, unknown>, k: string, optional = false): number | undefined {
  const x = o[k];
  if (x === undefined && optional) return undefined;
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) {
    throw new RouteTableError(`field ${k} is not a non-negative integer`);
  }
  return x;
}

export function decodeTenantEntry(value: string): TenantEntry {
  const o = parseObject(value);
  const s = str(o, 's');
  if (s !== 'active' && s !== 'suspended') throw new RouteTableError('field s is not a status');
  return tenantEntry({
    c: str(o, 'c')!,
    ac: str(o, 'ac')!,
    dt: int(o, 'dt')!,
    s,
    n: str(o, 'n')!,
    d: str(o, 'd', true),
    dk: str(o, 'dk', true),
    dx: int(o, 'dx', true),
  });
}

export function decodeHostEntry(value: string): HostEntry {
  const o = parseObject(value);
  return { v: 1, t: str(o, 't')!, ac: str(o, 'ac')! };
}

export function decodeCellEntry(value: string): CellEntry {
  const o = parseObject(value);
  return { v: 1, ac: str(o, 'ac')!, o: str(o, 'o')! };
}

export function decodeAppEntry(value: string): AppEntry {
  const o = parseObject(value);
  const e: Record<string, unknown> = {
    v: 1,
    az: str(o, 'az'),
    tk: str(o, 'tk'),
    cid: str(o, 'cid'),
    sc: str(o, 'sc'),
    lo: str(o, 'lo'),
  };
  const ex = str(o, 'ex', true);
  if (ex !== undefined) e.ex = ex;
  return e as unknown as AppEntry;
}

export function decodeSigninEntry(value: string): SigninEntry {
  const o = parseObject(value);
  const k = o.k;
  if (typeof k !== 'object' || k === null || Array.isArray(k)) throw new RouteTableError('field k is not an object');
  for (const [kid, key] of Object.entries(k)) {
    if (!/^[a-z0-9]{1,8}$/.test(kid) || typeof key !== 'string') throw new RouteTableError('field k holds a bad key');
  }
  const cur = str(o, 'cur')!;
  if (!(cur in k)) throw new RouteTableError('field cur names no key');
  return { v: 1, cur, k: k as Record<string, string> };
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/**
 * The display name rule (§4.1): each control character becomes a space,
 * `"` becomes `'` and `\` becomes `/`; then the string is cut to at most 64
 * UTF-8 bytes on a code-point boundary. No stored character then needs
 * JSON escaping.
 */
export function sanitiseDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const replaced = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").replace(/\\/g, '/');
  let out = '';
  let bytes = 0;
  for (const ch of replaced) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > MAX_DISPLAY_NAME_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** RFC 3339 `date-time` in UTC, with an optional fraction (control-plane §4). */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Turns the control plane's `createdAt` into `dt`, Unix ms (§4.1). Both
 * `...:01Z` and `...:01.000Z` give the same value. Returns undefined for a
 * value that does not parse; the registrar then answers 503 (§5.1). The
 * strings are never compared.
 */
export function parseCreatedAt(createdAt: unknown): number | undefined {
  if (typeof createdAt !== 'string' || !RFC3339_UTC.test(createdAt)) return undefined;
  const ms = Date.parse(createdAt);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
}
