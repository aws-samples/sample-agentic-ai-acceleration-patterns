// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import {
  appEntry,
  cellEntry,
  cellKey,
  decodeAppEntry,
  decodeCellEntry,
  decodeHostEntry,
  decodeSigninEntry,
  decodeTenantEntry,
  encodeEntry,
  hostEntry,
  hostKey,
  isReservedLabel,
  MAX_DISPLAY_NAME_BYTES,
  MAX_STORE_BYTES,
  parseCreatedAt,
  RouteTableError,
  sanitiseDisplayName,
  signinEntry,
  STORE_ALARM_BYTES,
  tenantEntry,
  tenantKey,
  toControlPlaneId,
  toStoredId,
} from '../../src/shared/route-table';

interface Fixture {
  readonly kind: 'tenant' | 'host' | 'cell' | 'app' | 'signin';
  readonly key?: string;
  readonly value: string;
  readonly why?: string;
}
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/route-table.json'), 'utf8')) as {
  valid: Fixture[];
  invalid: Fixture[];
};

const DECODERS = {
  tenant: decodeTenantEntry,
  host: decodeHostEntry,
  cell: decodeCellEntry,
  app: decodeAppEntry,
  signin: decodeSigninEntry,
} as const;

describe('golden entries (spec §4.1)', () => {
  test.each(fixtures.valid.map((f) => [f.kind, f.key, f]))('%s %s round-trips byte for byte', (_k, _key, f) => {
    const decoded = DECODERS[f.kind](f.value);
    expect(encodeEntry(decoded)).toBe(f.value);
  });

  test.each(fixtures.invalid.map((f) => [f.kind, f.why, f]))('%s refused: %s', (_k, _why, f) => {
    expect(() => DECODERS[f.kind](f.value)).toThrow(RouteTableError);
  });
});

describe('keys and ids', () => {
  const ULID = '01HZX8K9P0QRST7VWXYZ1A2B3C';

  test('keys use the lower-case id', () => {
    expect(tenantKey(ULID)).toBe('tenant#01hzx8k9p0qrst7vwxyz1a2b3c');
    expect(cellKey(ULID)).toBe('cell#01hzx8k9p0qrst7vwxyz1a2b3c');
    expect(hostKey('A.Tenants.Example.COM')).toBe('host#a.tenants.example.com');
  });

  test('a stored id round-trips to the control-plane form', () => {
    expect(toControlPlaneId(toStoredId(ULID))).toBe(ULID);
  });

  test.each(['', '-a', 'a-', 'a_b', 'a.b', 'x'.repeat(64)])('refuses %p as a stored id', (id) => {
    expect(() => toStoredId(id)).toThrow(RouteTableError);
  });

  test('refuses a non-ULID for the control plane', () => {
    expect(() => toControlPlaneId('acme')).toThrow(RouteTableError);
  });

  test.each(['www', 'API', 'admin', 'auth', 'login', 'static', 'status'])('%s is reserved', (label) => {
    expect(isReservedLabel(label)).toBe(true);
  });

  test('a tenant label is not reserved', () => {
    expect(isReservedLabel('acme')).toBe(false);
  });
});

describe('display name (§4.1)', () => {
  test('replaces control characters, quotes and backslashes', () => {
    expect(sanitiseDisplayName('A\u0000B\tC\u007f"D"\\E')).toBe("A B C 'D'/E");
  });

  test('cuts to 64 UTF-8 bytes on a code-point boundary', () => {
    const name = 'é'.repeat(40); // 80 bytes
    const out = sanitiseDisplayName(name);
    expect(Buffer.byteLength(out, 'utf8')).toBe(64);
    expect(out).toBe('é'.repeat(32));
    const emoji = 'a'.repeat(62) + '😀'; // 62 + 4 bytes
    expect(sanitiseDisplayName(emoji)).toBe('a'.repeat(62));
  });

  test('replaces an unpaired surrogate, so it needs no escaping', () => {
    const out = sanitiseDisplayName('a\ud800b\udc00c😀');
    expect(out).toBe('a\ufffdb\ufffdc😀');
    expect(JSON.stringify(out)).toBe(`"${out}"`);
  });

  test('needs no JSON escaping once sanitised', () => {
    const out = sanitiseDisplayName('x"\\\u0001'.repeat(30));
    expect(JSON.stringify(out)).toBe(`"${out}"`);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_DISPLAY_NAME_BYTES);
  });
});

describe('createdAt to dt (§4.1)', () => {
  test('with and without a zero fraction give the same dt', () => {
    expect(parseCreatedAt('2026-11-18T14:42:01Z')).toBe(parseCreatedAt('2026-11-18T14:42:01.000Z'));
    expect(parseCreatedAt('2026-11-18T14:42:01.123Z')).toBe(Date.UTC(2026, 10, 18, 14, 42, 1, 123));
  });

  test.each([
    ['2026-11-18T14:42:01.1Z', 100],
    ['2026-11-18T14:42:01.12Z', 120],
    ['2026-11-18T14:42:01.1239Z', 123],
    ['2026-11-18T14:42:01.123456789Z', 123],
  ])('cuts the fraction %s to milliseconds', (v, ms) => {
    expect(parseCreatedAt(v)).toBe(Date.UTC(2026, 10, 18, 14, 42, 1, ms));
  });

  test('accepts 29 February in a leap year', () => {
    expect(parseCreatedAt('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29));
  });

  test.each([
    undefined,
    1795080000000,
    '',
    '2026-11-18',
    '2026-11-18T14:42:01+01:00',
    '2026-11-18 14:42:01Z',
    '2026-11-18t14:42:01z',
    'garbage',
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-11-00T00:00:00Z',
    '2026-11-18T24:00:00Z',
    '2026-11-18T23:60:00Z',
    '2026-11-18T23:59:60Z',
    '1969-12-31T23:59:59Z',
    '2026-11-18T14:42:01.Z',
  ])('does not parse %p', (v) => {
    expect(parseCreatedAt(v)).toBeUndefined();
  });
});

describe('store limits', () => {
  test('the alarm sits at 80 % of the store', () => {
    expect(STORE_ALARM_BYTES).toBe(0.8 * MAX_STORE_BYTES);
  });
});

describe('builders fix the field order', () => {
  test('whatever order the caller writes', () => {
    expect(encodeEntry(hostEntry({ ac: '1', t: 'a' } as never))).toBe('{"v":1,"t":"a","ac":"1"}');
    expect(encodeEntry(cellEntry({ o: 'h', ac: '1' } as never))).toBe('{"v":1,"ac":"1","o":"h"}');
    expect(encodeEntry(appEntry({ lo: 'l', sc: 's', cid: 'c', tk: 't', az: 'a' } as never))).toBe(
      '{"v":1,"az":"a","tk":"t","cid":"c","sc":"s","lo":"l"}',
    );
    expect(encodeEntry(signinEntry({ k: { k1: 'x' }, cur: 'k1' } as never))).toBe('{"v":1,"cur":"k1","k":{"k1":"x"}}');
  });

  test('dk and dx need d', () => {
    expect(() => tenantEntry({ c: 'c', ac: '1', dt: 1, s: 'active', n: '', dk: 'k' })).toThrow(RouteTableError);
  });

  test.each([{ k: { K1: 'x' }, cur: 'K1' }, { k: { k1: 'x' }, cur: 'k2' }, { k: { abcdefghi: 'x' }, cur: 'abcdefghi' }])(
    'refuses signin %p',
    (fields) => {
      expect(() => signinEntry(fields as never)).toThrow(RouteTableError);
    },
  );
});

describe('worst-case sizes match the spec ceilings (§4.1, ADR-0012)', () => {
  const id63 = 'a'.repeat(63);
  const ulid = '01hzx8k9p0qrst7vwxyz1a2b3c';
  const appDomain = `${'b'.repeat(56)}.example`; // 64 characters, so a pooled host is 128
  const pooled = tenantEntry({ c: ulid, ac: '111111111111', dt: 1795080000000, s: 'suspended', n: 'n'.repeat(64) });

  test('a single-mode tenant needs 236 bytes', () => {
    const key = tenantKey(id63);
    const value = encodeEntry(pooled);
    expect(key.length).toBe(70);
    expect(Buffer.byteLength(value)).toBe(166);
    expect(Math.floor(STORE_ALARM_BYTES / (70 + 166))).toBe(16_949);
  });

  test('host mode adds a 230-byte host entry', () => {
    const host = `${id63}.${appDomain}`;
    const key = hostKey(host);
    const value = encodeEntry({ v: 1, t: id63, ac: '111111111111' });
    expect(key.length).toBe(133);
    expect(Buffer.byteLength(value)).toBe(97);
    expect(Math.floor(STORE_ALARM_BYTES / (236 + 230))).toBe(8_583);
  });

  test('a dedicated tenant with an open challenge stays inside 1 KB', () => {
    const value = encodeEntry(
      tenantEntry({ ...pooled, d: 'd'.repeat(64), dk: 'k'.repeat(43), dx: 1795684800 }),
    );
    expect(Buffer.byteLength(value)).toBe(166 + 71 + 51 + 16);
  });

  test('a value over 1 KB is refused', () => {
    expect(() => encodeEntry(tenantEntry({ ...pooled, n: 'x'.repeat(1000) }))).toThrow(RouteTableError);
  });
});
