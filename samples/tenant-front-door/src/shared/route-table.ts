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

/**
 * KeyValueStore's limit for the whole store, read as 5,000,000 bytes: the
 * conservative reading of "5 MB", so the registrar's 507 comes before the
 * store's own refusal (ADR-0012).
 */
export const MAX_STORE_BYTES = 5_000_000;

/** The registrar's alarm and stated ceilings sit at 80 % of the store (§4.1, ADR-0012). */
export const STORE_ALARM_BYTES = 4_000_000;

/** The registrar's store-size metric (§4.1): EMF, maximum statistic, alarm at `STORE_ALARM_BYTES`. */
export const METRIC_NAMESPACE = 'TenantFrontDoor';
export const METRIC_ROUTE_TABLE_BYTES = 'RouteTableBytes';

/** A `signin` key id (§3.6). */
export const SIGNIN_KID = /^[a-z0-9]{1,8}$/;

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
  /**
   * Domain challenge token, 43 base64url characters, with `d` for as long
   * as `d` exists. `dk` without `dx` is a passed challenge, the marker the
   * daily re-check selects on (§3.4 step 5).
   */
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

// Builders: every writer goes through one of these, so each value's fields
// are in the §4.1 order and the bytes match the golden fixtures.

/**
 * Builds a `tenant#` value with its fields in the §4.1 order. `d` and `dk`
 * come together; `dx` only with both (an open challenge).
 */
export function tenantEntry(fields: Omit<TenantEntry, 'v'>): TenantEntry {
  if ((fields.d === undefined) !== (fields.dk === undefined)) {
    throw new RouteTableError('d and dk come together');
  }
  if (fields.dx !== undefined && fields.dk === undefined) {
    throw new RouteTableError('dx needs d and dk');
  }
  const e: Record<string, unknown> = { v: 1, c: fields.c, ac: fields.ac, dt: fields.dt, s: fields.s, n: fields.n };
  if (fields.d !== undefined) e.d = fields.d;
  if (fields.dk !== undefined) e.dk = fields.dk;
  if (fields.dx !== undefined) e.dx = fields.dx;
  return e as unknown as TenantEntry;
}

export function hostEntry(fields: Omit<HostEntry, 'v'>): HostEntry {
  return { v: 1, t: fields.t, ac: fields.ac };
}

export function cellEntry(fields: Omit<CellEntry, 'v'>): CellEntry {
  return { v: 1, ac: fields.ac, o: fields.o };
}

export function appEntry(fields: Omit<AppEntry, 'v'>): AppEntry {
  const e: Record<string, unknown> = { v: 1, az: fields.az, tk: fields.tk, cid: fields.cid, sc: fields.sc, lo: fields.lo };
  if (fields.ex !== undefined) e.ex = fields.ex;
  return e as unknown as AppEntry;
}

export function signinEntry(fields: Omit<SigninEntry, 'v'>): SigninEntry {
  for (const kid of Object.keys(fields.k)) {
    if (!SIGNIN_KID.test(kid)) throw new RouteTableError('signin key id is malformed');
  }
  if (!(fields.cur in fields.k)) throw new RouteTableError('field cur names no key');
  return { v: 1, cur: fields.cur, k: fields.k };
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
  return hostEntry({ t: str(o, 't')!, ac: str(o, 'ac')! });
}

export function decodeCellEntry(value: string): CellEntry {
  const o = parseObject(value);
  return cellEntry({ ac: str(o, 'ac')!, o: str(o, 'o')! });
}

export function decodeAppEntry(value: string): AppEntry {
  const o = parseObject(value);
  return appEntry({
    az: str(o, 'az')!,
    tk: str(o, 'tk')!,
    cid: str(o, 'cid')!,
    sc: str(o, 'sc')!,
    lo: str(o, 'lo')!,
    ex: str(o, 'ex', true),
  });
}

export function decodeSigninEntry(value: string): SigninEntry {
  const o = parseObject(value);
  const k = o.k;
  if (typeof k !== 'object' || k === null || Array.isArray(k)) throw new RouteTableError('field k is not an object');
  for (const key of Object.values(k)) {
    if (typeof key !== 'string') throw new RouteTableError('field k holds a bad key');
  }
  return signinEntry({ cur: str(o, 'cur')!, k: k as Record<string, string> });
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
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function sanitiseDisplayName(name: string): string {
  // An unpaired surrogate would be written as a six-byte \uXXXX escape, so
  // replace it with U+FFFD first.
  // eslint-disable-next-line no-control-regex
  const replaced = name.replace(LONE_SURROGATE, '\ufffd').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, "'").replace(/\\/g, '/');
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
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Turns the control plane's `createdAt` into `dt`, Unix ms (§4.1). Both
 * `...:01Z` and `...:01.000Z` give the same value. The fields are checked
 * by hand, so an impossible date (`02-30`, `24:00`) is refused rather than
 * rolled over. A fraction past milliseconds is cut off (the control plane
 * stores milliseconds). A leap second (`:60`) and a time before 1970 are
 * refused: the control plane writes neither. Returns undefined for a
 * value it refuses; the registrar then answers 503 (§5.1). The strings are
 * never compared.
 */
export function parseCreatedAt(createdAt: unknown): number | undefined {
  if (typeof createdAt !== 'string') return undefined;
  const m = RFC3339_UTC.exec(createdAt);
  if (m === null) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const ms = Number(((m[7] ?? '') + '000').slice(0, 3));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}
