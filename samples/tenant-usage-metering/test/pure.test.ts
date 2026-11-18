// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkRange } from '../src/api/jobs';
import { createEffectiveFrom } from '../src/api/meters';
import { decodeToken, encodeToken } from '../src/api/pagination';
import { ADMIN_ROUTES, policyPath } from '../src/api/routes';
import { validateSink } from '../src/api/sinks';
import { authHeader, mappedBody, needsBillingAccount, retryDelaySeconds } from '../src/dispatcher/dispatcher';
import { busBatches, packByHour } from '../src/ingest/publish';
import { markerArrived, sinksToQueue, usageRecordedDetail } from '../src/publisher/publisher';
import { retryBackoffMs, takeable } from '../src/recount/count';
import { eventsOfObject } from '../src/recount/stored-events';
import { decide } from '../src/scheduler/scheduler';
import { callerIsListed, roleFromCallerArn } from '../src/shared/identity';
import { billingBinding, type BindingItem, type HourItem, type SinkItem, type UsageRecordItem, versionAt, type MeterVersionItem } from '../src/shared/items';
import { splitConcatenatedJson } from '../src/shared/json-stream';
import { ingestDeduplicationId, publishShard, recordId } from '../src/shared/keys';
import { closeAttributes, reactivation, updateExpression } from '../src/shared/registration';
import { closeTimeMs, hoursBetween, nextWholeHour, pastCloseGuard } from '../src/shared/time';
import type { EnrichedUsageEvent } from '../src/shared/usage-event';
import { decodeS3Key, hourOfObjectKey } from '../src/tracker/track';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const HOUR = '2026-11-18T10';
const event = (overrides: Partial<EnrichedUsageEvent> = {}): EnrichedUsageEvent => ({
  eventId: '01JD0000000000000000000001',
  tenantId: 'tenant-a',
  meterId: 'agent.tokens',
  value: '10',
  time: '2026-11-18T10:15:00Z',
  applicationId: 'demo-app',
  cellId: '01JD00000000000000000000C1',
  emitterAccountId: '111122223333',
  emitterRole: 'demo-ue-01JD00000000000000000000C1',
  receivedAt: '2026-11-18T10:15:01Z',
  ...overrides,
});

const MODEL_OPERATIONS = [...fs.readFileSync(path.join(__dirname, '..', 'model', 'metering.smithy'), 'utf8').matchAll(/^operation (\w+)/gm)].map((match) => match[1]);

describe('routes (spec §3.2)', () => {
  test('every model operation but PutUsageEvents has exactly one admin route', () => {
    expect(MODEL_OPERATIONS).toHaveLength(30);
    for (const operation of MODEL_OPERATIONS) {
      const routes = ADMIN_ROUTES.filter((route) => route.operation === operation);
      expect(routes).toHaveLength(operation === 'PutUsageEvents' ? 0 : 1);
    }
  });
  test('registration writes are for the registrar only, and no operator route registers', () => {
    const registrar = ADMIN_ROUTES.filter((route) => route.callers.includes('registrar')).map((route) => route.operation).sort();
    expect(registrar).toEqual(['DeleteCellEmitter', 'DeleteTenantBinding', 'PutCellEmitter', 'PutTenantBinding']);
    expect(ADMIN_ROUTES.filter((route) => route.callers.includes('registrar') && route.callers.length > 1)).toHaveLength(0);
  });
  test('readers reach the two usage reads only', () => {
    expect(ADMIN_ROUTES.filter((route) => route.callers.includes('reader')).map((route) => route.operation).sort()).toEqual(['GetUsage', 'ListUsage']);
  });
  test('policy paths put * for labels', () => {
    expect(policyPath({ operation: 'X', method: 'PUT', path: '/cells/{cellId}/tenants/{tenantId}', callers: [] })).toBe('PUT/cells/*/tenants/*');
  });
});

describe('caller identity (spec §3.2)', () => {
  test('an assumed role is reduced to its role, and matches a listed ARN with a path', () => {
    const caller = roleFromCallerArn('arn:aws:sts::111122223333:assumed-role/ops/session-1')!;
    expect(caller.roleArn).toBe('arn:aws:iam::111122223333:role/ops');
    expect(callerIsListed(caller, ['arn:aws:iam::111122223333:role/team/ops'])).toBe(true);
    expect(callerIsListed(caller, ['arn:aws:iam::444455556666:role/ops'])).toBe(false);
    expect(roleFromCallerArn('arn:aws:iam::111122223333:user/alice')).toBeUndefined();
  });
});

describe('pagination tokens', () => {
  test('a token continues only the query it was issued for', () => {
    const token = encodeToken('ListMeters', { PK: 'METER#a', SK: 'CURRENT' })!;
    expect(decodeToken('ListMeters', token)).toEqual({ PK: 'METER#a', SK: 'CURRENT' });
    expect(() => decodeToken('ListSinks', token)).toThrow();
    expect(() => decodeToken('ListMeters', 'not-a-token')).toThrow();
  });
});

describe('meters (spec §4.1)', () => {
  test('effectiveFrom defaults to the next whole hour and may go back inside the window', () => {
    expect(createEffectiveFrom(undefined, NOW, 96)).toBe('2026-11-18T13');
    expect(createEffectiveFrom('2026-11-15T00', NOW, 96)).toBe('2026-11-15T00');
    expect(() => createEffectiveFrom('2026-11-10T00', NOW, 96)).toThrow(/recount window/);
    expect(() => createEffectiveFrom('2026-11-18T14', NOW, 96)).toThrow();
  });
  test('the version in effect is the latest effectiveFrom at or before the hour, the higher version on a tie', () => {
    const v = (version: number, effectiveFrom: string) => ({ version, effectiveFrom }) as MeterVersionItem;
    const versions = [v(1, '2026-11-01T00'), v(2, '2026-11-18T11'), v(3, '2026-11-18T11')];
    expect(versionAt(versions, '2026-11-18T10')?.version).toBe(1);
    expect(versionAt(versions, '2026-11-18T11')?.version).toBe(3);
    expect(versionAt(versions, '2026-10-01T00')).toBeUndefined();
  });
});

describe('sinks (spec §4.4)', () => {
  const sink = (overrides: Partial<SinkItem>): SinkItem =>
    ({ PK: 'SINK#s', SK: 'META', sinkId: 's', type: 'HTTP', enabled: true, endpoint: 'https://billing.example.com/usage', secretName: 'demo/metering/sinks/s', createdBy: 'x', createdAt: 'x', ...overrides }) as SinkItem;
  test('an HTTP sink needs https, a DNS name and a secret under the fleet prefix', () => {
    expect(() => validateSink(sink({}), 'demo')).not.toThrow();
    expect(() => validateSink(sink({ endpoint: 'http://billing.example.com' }), 'demo')).toThrow();
    expect(() => validateSink(sink({ endpoint: 'https://10.0.0.1/x' }), 'demo')).toThrow();
    expect(() => validateSink(sink({ endpoint: 'https://user:pw@billing.example.com/' }), 'demo')).toThrow();
    expect(() => validateSink(sink({ secretName: 'other/metering/sinks/s' }), 'demo')).toThrow();
  });
  test('an S3_EXPORT sink is a clean key prefix and takes no secret', () => {
    expect(validateSink(sink({ type: 'S3_EXPORT', endpoint: 'exports/billing', secretName: undefined }), 'demo').endpoint).toBe('exports/billing/');
    expect(() => validateSink(sink({ type: 'S3_EXPORT', endpoint: '../x', secretName: undefined }), 'demo')).toThrow();
    expect(() => validateSink(sink({ type: 'S3_EXPORT', endpoint: 'x/' }), 'demo')).toThrow();
  });
});

describe('registrations (spec §4.2, §4.3)', () => {
  test('closing sets the grace and the TTL at the end of the hour plus the window', () => {
    const close = closeAttributes(NOW, 60, 96, { executionId: 'e1' });
    expect(close).toMatchObject({ status: 'CLOSING', closedAt: '2026-11-18T12:30:00.000Z', closesAt: '2026-11-18T13:30:00.000Z', closedByExecutionId: 'e1' });
    expect(close.expiresAt).toBe(Math.floor(Date.parse('2026-11-22T13:00:00Z') / 1000));
  });
  test('re-activation moves the closed interval and drops ones past the window', () => {
    const { set, remove } = reactivation(
      {
        status: 'CLOSING',
        activeFrom: '2026-11-18T00:00:00Z',
        closedAt: '2026-11-18T06:00:00Z',
        closedByExecutionId: 'e1',
        intervals: [{ activeFrom: '2026-10-01T00:00:00Z', closedAt: '2026-10-02T00:00:00Z' }],
      },
      NOW,
      96,
      { executionId: 'e2' },
    );
    expect(set.intervals).toEqual([{ activeFrom: '2026-11-18T00:00:00Z', closedAt: '2026-11-18T06:00:00Z', closedByExecutionId: 'e1' }]);
    expect(set).toMatchObject({ status: 'ACTIVE', controlPlaneExecutionId: 'e2' });
    expect(remove).toEqual(expect.arrayContaining(['closedAt', 'closesAt', 'expiresAt', 'controlPlaneOperatorId']));
  });
  test('update expressions name every attribute', () => {
    expect(updateExpression({ status: 'ACTIVE' }, ['closedAt'])).toEqual({
      UpdateExpression: 'SET #s0 = :s0 REMOVE #r0',
      ExpressionAttributeNames: { '#s0': 'status', '#r0': 'closedAt' },
      ExpressionAttributeValues: { ':s0': 'ACTIVE' },
    });
  });
  test('billing comes from the ACTIVE binding, else the latest CLOSING one', () => {
    const b = (status: 'ACTIVE' | 'CLOSING', billingAccount: string, closedAt?: string) => ({ status, billingAccount, closedAt }) as BindingItem;
    expect(billingBinding([b('CLOSING', 'old', '2026-11-01T00:00:00Z'), b('ACTIVE', 'now')])?.billingAccount).toBe('now');
    expect(billingBinding([b('CLOSING', 'a', '2026-11-01T00:00:00Z'), b('CLOSING', 'b', '2026-11-02T00:00:00Z')])?.billingAccount).toBe('b');
  });
});

describe('hours (spec §4.5)', () => {
  const hour = (overrides: Partial<HourItem>): HourItem => ({ PK: `HOUR#${HOUR}`, SK: 'META', hour: HOUR, status: 'OPEN', attempts: 0, ...overrides });
  test('an hour is taken past its grace, when dirty, after its backoff, or from a lapsed lease', () => {
    expect(takeable(hour({}), Date.parse('2026-11-18T11:10:00Z'), 15).take).toBe(false);
    expect(takeable(hour({}), Date.parse('2026-11-18T11:16:00Z'), 15).take).toBe(true);
    expect(takeable(hour({ status: 'DIRTY' }), NOW, 15).take).toBe(true);
    expect(takeable(hour({ status: 'COUNT_FAILED', retryAfter: '2026-11-18T13:00:00Z' }), NOW, 15).take).toBe(false);
    expect(takeable(hour({ status: 'COUNTING', leaseExpiresAt: '2026-11-18T12:00:00Z' }), NOW, 15)).toEqual({ take: true, takeover: true });
    expect(takeable(hour({ status: 'COUNTED' }), NOW, 15).take).toBe(false);
  });
  test('the scheduler marks moved hours dirty, closes counted hours past their close, and starts due ones', () => {
    const closeAt = closeTimeMs(HOUR, 96);
    expect(decide(hour({ status: 'COUNTED', countedGeneration: 2 }), 3, NOW, 15, 96)).toBe('MARK_DIRTY');
    expect(decide(hour({ status: 'COUNTED', countedGeneration: 3 }), 3, NOW, 15, 96)).toBe('WAIT');
    expect(decide(hour({ status: 'COUNTED', countedGeneration: 3 }), 3, closeAt, 15, 96)).toBe('CLOSE');
    expect(decide(hour({ status: 'DIRTY' }), 3, NOW, 15, 96)).toBe('START');
  });
  test('backoff doubles per attempt, at most an hour; the close guard is 5 minutes', () => {
    expect(retryBackoffMs(1)).toBe(2 * 60_000);
    expect(retryBackoffMs(10)).toBe(60 * 60_000);
    expect(pastCloseGuard(HOUR, closeTimeMs(HOUR, 96) - 6 * 60_000, 96)).toBe(false);
    expect(pastCloseGuard(HOUR, closeTimeMs(HOUR, 96) - 4 * 60_000, 96)).toBe(true);
    expect(nextWholeHour(NOW)).toBe('2026-11-18T13');
    expect(hoursBetween('2026-11-18T22', '2026-11-19T01')).toEqual(['2026-11-18T22', '2026-11-18T23', '2026-11-19T00', '2026-11-19T01']);
    expect(() => checkRange('2026-11-19T01', '2026-11-18T22')).toThrow();
    expect(() => checkRange('2026-10-01T00', '2026-11-18T22')).toThrow();
  });
  test('the tracker reads the hour from raw/ and readmitted/ keys only', () => {
    expect(hourOfObjectKey(decodeS3Key('raw/hour%3D2026-11-18T10/file-1'))).toBe(HOUR);
    expect(hourOfObjectKey('readmitted/hour=2026-11-18T10/job.ndjson')).toBe(HOUR);
    expect(hourOfObjectKey('error/hour=2026-11-18T10/x.json')).toBeUndefined();
    expect(hourOfObjectKey('raw/hour=2026-13-18T10/x')).toBeUndefined();
  });
});

describe('stored objects (spec §4.8)', () => {
  test('concatenated values split with or without whitespace, and a bad one is counted', () => {
    expect(splitConcatenatedJson('{"a":1}{"b":"}{"}\n{"c":[1,2]}')).toEqual({ values: [{ a: 1 }, { b: '}{' }, { c: [1, 2] }], malformed: 0 });
    expect(splitConcatenatedJson('{"a":1}x{"b":').malformed).toBeGreaterThan(0);
  });
  test('BUS envelopes, DIRECT packs and NDJSON give the same events; other hours are skipped', () => {
    const e = event();
    const bus = `${JSON.stringify({ source: 'metering.ingest', detail: e })}${JSON.stringify({ detail: event({ time: '2026-11-18T11:00:00Z' }) })}`;
    expect(eventsOfObject(bus, HOUR)).toEqual({ events: [e], skipped: 1 });
    expect(eventsOfObject(JSON.stringify({ hour: HOUR, events: [e] }), HOUR).events).toEqual([e]);
    expect(eventsOfObject(`${JSON.stringify(e)}\n`, HOUR).events).toEqual([e]);
    expect(eventsOfObject(JSON.stringify({ ...e, receivedAt: undefined }), HOUR).skipped).toBe(1);
  });
  test('ingest publishing packs per hour and splits bus calls by count and size', () => {
    const packed = packByHour([event(), event({ time: '2026-11-18T11:00:00Z' }), event({ eventId: '01JD0000000000000000000002' })]);
    expect(packed.map((group) => [group.record.hour, group.indexes])).toEqual([
      [HOUR, [0, 2]],
      ['2026-11-18T11', [1]],
    ]);
    expect(busBatches([1, 2, 3, 4, 5], () => 100, 2, 1000).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(busBatches([1, 2, 3], () => 600, 100, 1000).map((batch) => batch.length)).toEqual([1, 1, 1]);
  });
  test('the bus deduplication id stays under 128 characters for the longest key', () => {
    expect(ingestDeduplicationId('a'.repeat(32), 'T'.repeat(64), '0'.repeat(36))).toHaveLength(64);
  });
});

describe('records and deliveries (spec §4.7)', () => {
  const record = (overrides: Partial<UsageRecordItem> = {}): UsageRecordItem =>
    ({
      PK: 'USAGE#tenant-a#demo-app',
      SK: `${HOUR}#agent.tokens#0000`,
      recordId: recordId('tenant-a', 'demo-app', 'agent.tokens', HOUR, 0),
      kind: 'HOURLY',
      tenantId: 'tenant-a',
      applicationId: 'demo-app',
      meterId: 'agent.tokens',
      meterVersion: 1,
      unit: 'tokens',
      hour: HOUR,
      seq: 0,
      revision: 1,
      quantity: '10',
      total: '10',
      eventCount: 1,
      publishPending: '2026-11-18T11:20:00Z',
      sinks: { a: { status: 'PENDING' }, b: { status: 'SENT' }, c: { status: 'BLOCKED' } },
      createdAt: 'x',
      ...overrides,
    }) as UsageRecordItem;
  test('record ids are stable and spread over four shards', () => {
    expect(recordId('t', 'a', 'm', HOUR, 0)).toBe(recordId('t', 'a', 'm', HOUR, 0));
    expect(recordId('t', 'a', 'm', HOUR, 0)).not.toBe(recordId('t', 'a', 'm', HOUR, 1));
    expect(publishShard('ff00')).toBe(255 % 4);
  });
  test('revision 1 queues every sink not yet settled; revision 2 only the BLOCKED ones', () => {
    expect(sinksToQueue(record())).toEqual(['a', 'c']);
    expect(sinksToQueue(record({ revision: 2 }))).toEqual(['c']);
  });
  test('the publisher acts when a marker arrives, not on sink-state writes', () => {
    const r = record();
    expect(markerArrived(r, undefined)).toBe(true);
    expect(markerArrived(r, { ...r })).toBe(false);
    expect(markerArrived(r, { ...r, publishPending: '2026-11-18T11:00:00Z' })).toBe(true);
    expect(markerArrived({ ...r, publishPending: undefined }, r)).toBe(false);
    expect(usageRecordedDetail(r)).not.toHaveProperty('billingAccount');
  });
  test('an HTTP mapping reads record fields, meter fields and constants', () => {
    const sink = { mapping: { account: { recordField: 'billingAccount' }, qty: { recordField: 'quantity' }, rule: { meterField: 'rule' }, plan: { constant: 'std' } } } as Pick<SinkItem, 'mapping'>;
    expect(mappedBody(sink, record({ billingAccount: 'acct-1' }), { meterId: 'agent.tokens', version: 1, unit: 'tokens', rule: 'SUM' })).toEqual({ account: 'acct-1', qty: '10', rule: 'SUM', plan: 'std' });
    expect(needsBillingAccount({ type: 'HTTP', mapping: sink.mapping })).toBe(true);
    expect(needsBillingAccount({ type: 'S3_EXPORT' })).toBe(false);
  });
  test('the sink secret is a header pair or a bearer token; retries back off to 15 minutes', () => {
    expect(authHeader('{"header":"X-Api-Key","value":"k"}')).toEqual(['X-Api-Key', 'k']);
    expect(authHeader('t0ken')).toEqual(['Authorization', 'Bearer t0ken']);
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(20)).toBe(900);
  });
});
