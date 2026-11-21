// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { dedupe, ExistingRecord, MeterVersion, recountHour } from '../src/recount/rule';
import { formatMicros, parseValue } from '../src/shared/decimal';
import type { EnrichedUsageEvent } from '../src/shared/usage-event';

const HOUR = '2026-11-18T12';
let n = 0;
const ev = (overrides: Partial<EnrichedUsageEvent> = {}): EnrichedUsageEvent => ({
  eventId: `01JD00000000000000000${String(n++).padStart(5, '0')}`,
  tenantId: 'tenant-a',
  meterId: 'tokens',
  value: '10',
  time: '2026-11-18T12:05:00Z',
  applicationId: 'app-1',
  emitterId: '01JD0000000000000000000000',
  emitterAccountId: '111122223333',
  emitterRole: 'demo-ue-01JD0000000000000000000000',
  receivedAt: '2026-11-18T12:05:01Z',
  ...overrides,
});
const meters: Record<string, MeterVersion> = {
  tokens: { meterId: 'tokens', version: 1, rule: 'SUM' },
  calls: { meterId: 'calls', version: 3, rule: 'COUNT' },
  peak: { meterId: 'peak', version: 1, rule: 'MAX' },
  users: { meterId: 'users', version: 1, rule: 'UNIQUE_COUNT' },
};
const meterAt = (id: string): MeterVersion | undefined => meters[id];

describe('decimal arithmetic (spec §4.8)', () => {
  test('sums are exact at 6 fractional digits', () => {
    expect(formatMicros(parseValue('0.1') + parseValue('0.2'))).toBe('0.3');
    expect(formatMicros(parseValue('999999999999.999999'))).toBe('999999999999.999999');
    expect(() => parseValue('1e3')).toThrow(RangeError);
  });
});

describe('dedupe (spec §4.9 step 1, P-5)', () => {
  test('one event per (applicationId, tenantId, eventId); the earliest receivedAt wins', () => {
    const first = ev({ eventId: '01JD0000000000000000000AAA', value: '5', receivedAt: '2026-11-18T12:05:00Z' });
    const retry = { ...first, value: '7', receivedAt: '2026-11-18T12:06:00Z' };
    expect(dedupe([retry, first])).toEqual([first]);
  });

  test('another application with the same event id is a different event', () => {
    const a = ev({ eventId: '01JD0000000000000000000BBB' });
    const b = { ...a, applicationId: 'app-2' };
    expect(dedupe([a, b])).toHaveLength(2);
  });

  test('ties on receivedAt break on canonical JSON, whatever the read order', () => {
    const a = ev({ eventId: '01JD0000000000000000000CCC', value: '1' });
    const b = { ...a, value: '2' };
    expect(dedupe([a, b])).toEqual(dedupe([b, a]));
    expect(dedupe([b, a])[0].value).toBe('1');
  });
});

describe('recountHour (spec §4.9, ADR-0003)', () => {
  const events = [
    ev({ value: '10' }),
    ev({ value: '2.5' }),
    ev({ meterId: 'calls' }),
    ev({ meterId: 'calls' }),
    ev({ meterId: 'peak', value: '4' }),
    ev({ meterId: 'peak', value: '9' }),
    ev({ meterId: 'users', value: 'u1' as string }),
  ];

  test('a first count writes one HOURLY per group under each meter rule', () => {
    const records = recountHour(HOUR, events.filter((e) => e.meterId !== 'users'), [], meterAt);
    expect(records.map((r) => [r.meterId, r.kind, r.seq, r.quantity, r.total, r.eventCount])).toEqual([
      ['calls', 'HOURLY', 0, '2', '2', 2],
      ['peak', 'HOURLY', 0, '9', '9', 2],
      ['tokens', 'HOURLY', 0, '12.5', '12.5', 2],
    ]);
  });

  test('the same objects and records write nothing (P-4)', () => {
    const subset = events.filter((e) => e.meterId === 'tokens');
    const first = recountHour(HOUR, subset, [], meterAt);
    const existing: ExistingRecord[] = first.map((r) => ({ ...r }));
    expect(recountHour(HOUR, [...subset, ...subset], existing, meterAt)).toEqual([]);
  });

  test('a late event gives an ADJUSTMENT for the difference, with the new total (P-7)', () => {
    const subset = events.filter((e) => e.meterId === 'tokens');
    const existing: ExistingRecord[] = recountHour(HOUR, subset, [], meterAt).map((r) => ({ ...r }));
    const late = ev({ value: '0.25', receivedAt: '2026-11-18T13:40:00Z' });
    expect(recountHour(HOUR, [...subset, late], existing, meterAt)).toEqual([
      expect.objectContaining({ kind: 'ADJUSTMENT', seq: 1, quantity: '0.25', total: '12.75', eventCount: 3 }),
    ]);
  });

  test('a group whose meter has no version at the hour is skipped', () => {
    expect(recountHour(HOUR, [ev({ meterId: 'gone' })], [], meterAt)).toEqual([]);
  });

  test('UNIQUE_COUNT counts distinct values', () => {
    const users = [ev({ meterId: 'users', value: '1' }), ev({ meterId: 'users', value: '1' }), ev({ meterId: 'users', value: '2' })];
    expect(recountHour(HOUR, users, [], meterAt)[0].quantity).toBe('2');
  });
});
