// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { AdmissionContext, checkEvent, hourOf, Registration, registrationAdmits, timeCheck } from '../src/shared/usage-event';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const event = {
  eventId: '01JD0000000000000000000001',
  tenantId: 'tenant-a',
  meterId: 'agent.tokens',
  value: '120.5',
  time: '2026-11-18T12:10:00Z',
};
const active: Registration = { status: 'ACTIVE', activeFrom: '2026-11-18T00:00:00Z' };

const ctx = (overrides: Partial<AdmissionContext> = {}): AdmissionContext => ({
  nowMs: NOW,
  recountWindowHours: 96,
  applicationId: 'demo-app',
  binding: (tenantId) => (tenantId === 'tenant-a' ? active : undefined),
  meterAt: (meterId) => (meterId === 'agent.tokens' ? { status: 'ACTIVE' } : undefined),
  ...overrides,
});

describe('ingest checks (spec §4.8, §5)', () => {
  test('a well-formed event for a bound tenant and a known meter is admitted', () => {
    expect(checkEvent(event, ctx())).toBeUndefined();
  });

  test.each([
    ['a missing field', { ...event, eventId: undefined }],
    ['an event id that is neither ULID nor UUID', { ...event, eventId: 'abc' }],
    ['a negative value', { ...event, value: '-1' }],
    ['seven fractional digits', { ...event, value: '1.1234567' }],
    ['a time with an offset', { ...event, time: '2026-11-18T13:10:00+01:00' }],
    ['eleven dimensions', { ...event, dimensions: Object.fromEntries([...Array(11).keys()].map((i) => [`d${i}`, 'x'])) }],
  ])('%s is BAD_SHAPE', (_label, body) => {
    expect(checkEvent(body, ctx())).toBe('BAD_SHAPE');
  });

  test('more than 5 minutes ahead is BAD_TIME; an hour past the accept window is TOO_LATE', () => {
    expect(checkEvent({ ...event, time: '2026-11-18T12:36:00Z' }, ctx())).toBe('BAD_TIME');
    // 96 − 49 = 47 hours: the hour 11:00 two days back ended 49.5 h ago.
    expect(timeCheck('2026-11-16T11:59:59Z', NOW, 96)).toBe('TOO_LATE');
    expect(timeCheck('2026-11-16T14:00:00Z', NOW, 96)).toBeUndefined();
  });

  test('the refusal order follows spec §5', () => {
    expect(checkEvent({ ...event, tenantId: 'tenant-b' }, ctx())).toBe('TENANT_NOT_IN_CELL');
    expect(checkEvent({ ...event, meterId: 'unknown' }, ctx())).toBe('UNKNOWN_METER');
    expect(checkEvent(event, ctx({ meterAt: () => ({ status: 'RETIRED' }) }))).toBe('UNKNOWN_METER');
    expect(checkEvent(event, ctx({ meterAt: () => ({ status: 'ACTIVE', allowedApplications: ['other'] }) }))).toBe('METER_NOT_ALLOWED');
  });

  test('the hour key is UTC', () => {
    expect(hourOf('2026-11-18T12:59:59.999Z')).toBe('2026-11-18T12');
  });
});

describe('registration intervals (spec §4.2)', () => {
  const closing: Registration = {
    status: 'CLOSING',
    activeFrom: '2026-11-18T10:00:00Z',
    closedAt: '2026-11-18T12:00:00Z',
    closesAt: '2026-11-18T13:00:00Z',
    intervals: [{ activeFrom: '2026-11-17T00:00:00Z', closedAt: '2026-11-17T06:00:00Z' }],
  };

  test('a closing registration admits events up to closedAt until closesAt', () => {
    expect(registrationAdmits(closing, '2026-11-18T11:59:00Z', NOW)).toBe(true);
    expect(registrationAdmits(closing, '2026-11-18T12:01:00Z', NOW)).toBe(false);
    expect(registrationAdmits(closing, '2026-11-18T11:59:00Z', Date.parse('2026-11-18T13:00:01Z'))).toBe(false);
  });

  test('an earlier interval still admits its own events; the gap does not', () => {
    expect(registrationAdmits(closing, '2026-11-17T05:00:00Z', NOW)).toBe(true);
    expect(registrationAdmits(closing, '2026-11-17T08:00:00Z', NOW)).toBe(false);
  });

  test('events before activeFrom are REGISTRATION_CLOSED', () => {
    expect(checkEvent({ ...event, time: '2026-11-17T23:00:00Z' }, ctx())).toBe('REGISTRATION_CLOSED');
  });
});
