// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import {
  cellKey,
  decodeAppEntry,
  decodeCellEntry,
  decodeHostEntry,
  decodeSigninEntry,
  decodeTenantEntry,
  encodeEntry,
  hostKey,
  isReservedLabel,
  MAX_DISPLAY_NAME_BYTES,
  parseCreatedAt,
  RouteTableError,
  sanitiseDisplayName,
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

  test.each([undefined, 1795080000000, '', '2026-11-18', '2026-11-18T14:42:01+01:00', '2026-11-18 14:42:01Z', 'garbage'])(
    'does not parse %p',
    (v) => {
      expect(parseCreatedAt(v)).toBeUndefined();
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
