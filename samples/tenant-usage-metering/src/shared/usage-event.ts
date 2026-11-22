// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { isValue } from './decimal';

/**
 * The usage event and the ingest checks (spec §3.2, §4.2, §4.3, §4.8, §5).
 * Pure: the caller injects the registry and meter lookups, so the same
 * checks run at ingest and in `READMIT` (spec §4.6).
 */

export type RefusalReason =
  | 'TENANT_NOT_BOUND'
  | 'REGISTRATION_CLOSED'
  | 'UNKNOWN_METER'
  | 'METER_NOT_ALLOWED'
  | 'BAD_TIME'
  | 'TOO_LATE'
  | 'BAD_SHAPE';

/** Refusals that could still count, always stored (spec P-8). */
export const READMITTABLE: ReadonlySet<RefusalReason> = new Set<RefusalReason>([
  'TENANT_NOT_BOUND',
  'REGISTRATION_CLOSED',
  'UNKNOWN_METER',
  'METER_NOT_ALLOWED',
]);

/** The event as an emitter sends it. */
export interface UsageEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly meterId: string;
  readonly value: string;
  readonly time: string;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/** The event as the raw store holds it: the body plus the verified caller. */
export interface EnrichedUsageEvent extends UsageEvent {
  readonly applicationId: string;
  readonly emitterId: string;
  readonly emitterAccountId: string;
  readonly emitterRole: string;
  readonly receivedAt: string;
}

const EVENT_ID = /^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const METER_ID = /^[a-z0-9_.-]{1,64}$/;
const DIMENSION_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const MEMBERS: ReadonlySet<string> = new Set(['eventId', 'tenantId', 'meterId', 'value', 'time', 'dimensions']);
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Hours between the last admitted event's hour and its close (spec §3.3). */
export const DELIVERY_BUDGET_HOURS = 49;

/** The hour key of an instant: `YYYY-MM-DDTHH`, UTC. */
export function hourOf(time: string | Date): string {
  const iso = (typeof time === 'string' ? new Date(time) : time).toISOString();
  return iso.slice(0, 13);
}

/** The end of an hour key, in epoch ms. */
export function hourEndMs(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`) + HOUR_MS;
}

/** Shape checks only; `BAD_SHAPE` covers everything the model would refuse. */
export function shapeIsValid(event: unknown): event is UsageEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  if (Array.isArray(event)) {
    return false;
  }
  const e = event as Record<string, unknown>;
  if (Object.keys(e).some((key) => !MEMBERS.has(key))) {
    return false;
  }
  if (typeof e.eventId !== 'string' || !EVENT_ID.test(e.eventId)) return false;
  if (typeof e.tenantId !== 'string' || !TENANT_ID.test(e.tenantId)) return false;
  if (typeof e.meterId !== 'string' || !METER_ID.test(e.meterId)) return false;
  if (typeof e.value !== 'string' || !isValue(e.value)) return false;
  if (typeof e.time !== 'string' || !ISO_UTC.test(e.time) || Number.isNaN(Date.parse(e.time))) return false;
  if (e.dimensions !== undefined) {
    if (typeof e.dimensions !== 'object' || e.dimensions === null || Array.isArray(e.dimensions)) return false;
    const entries = Object.entries(e.dimensions as Record<string, unknown>);
    if (entries.length > 10) return false;
    for (const [key, value] of entries) {
      if (!DIMENSION_KEY.test(key) || typeof value !== 'string' || value.length > 256) return false;
    }
  }
  return true;
}

/**
 * Time checks (spec §4.8): at most 5 minutes in the future, and in an hour
 * that ended less than `recountWindowHours` − 49 hours ago.
 */
export function timeCheck(time: string, nowMs: number, recountWindowHours: number): 'BAD_TIME' | 'TOO_LATE' | undefined {
  const at = Date.parse(time);
  if (at > nowMs + FUTURE_SKEW_MS) {
    return 'BAD_TIME';
  }
  const acceptHours = recountWindowHours - DELIVERY_BUDGET_HOURS;
  if (hourEndMs(hourOf(time)) <= nowMs - acceptHours * HOUR_MS) {
    return 'TOO_LATE';
  }
  return undefined;
}

/** A registration interval: an emitter or a binding (spec §4.2, §4.3). */
export interface Registration {
  readonly status: 'ACTIVE' | 'CLOSING';
  readonly activeFrom: string;
  readonly closedAt?: string;
  readonly closesAt?: string;
  readonly intervals?: ReadonlyArray<{ readonly activeFrom: string; readonly closedAt: string }>;
}

/**
 * Whether a registration admits an event stamped `time`, judged as it stood
 * at that time (spec §4.2): the current interval, or one of `intervals`.
 * Past `closesAt` a closing registration admits nothing.
 */
export function registrationAdmits(registration: Registration, time: string, nowMs: number): boolean {
  const at = Date.parse(time);
  if (registration.status === 'CLOSING' && registration.closesAt !== undefined && nowMs > Date.parse(registration.closesAt)) {
    return false;
  }
  const inCurrent =
    at >= Date.parse(registration.activeFrom) &&
    (registration.status === 'ACTIVE' || registration.closedAt === undefined || at <= Date.parse(registration.closedAt));
  if (inCurrent) {
    return true;
  }
  return (registration.intervals ?? []).some(
    (interval) => at >= Date.parse(interval.activeFrom) && at <= Date.parse(interval.closedAt),
  );
}

/** The meter version in effect at an hour, as the lookup returns it. */
export interface MeterAtHour {
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly allowedApplications?: ReadonlyArray<string>;
}

export interface AdmissionContext {
  readonly nowMs: number;
  readonly recountWindowHours: number;
  /** The caller's application, from its emitter registration. */
  readonly applicationId: string;
  /** The caller's emitter registration (spec §4.2). */
  readonly emitter: Registration;
  /** The binding of `tenantId` to the calling emitter, if any. */
  binding(tenantId: string): Registration | undefined;
  /** The meter version in effect at `hour`, if any. */
  meterAt(meterId: string, hour: string): MeterAtHour | undefined;
}

/**
 * The ingest checks for one event of an already-admitted emitter, in the
 * order spec §5 lists the reasons. `undefined` means admitted.
 */
export function checkEvent(event: unknown, ctx: AdmissionContext): RefusalReason | undefined {
  if (!shapeIsValid(event)) {
    return 'BAD_SHAPE';
  }
  const time = timeCheck(event.time, ctx.nowMs, ctx.recountWindowHours);
  if (time !== undefined) {
    return time;
  }
  if (!registrationAdmits(ctx.emitter, event.time, ctx.nowMs)) {
    return 'REGISTRATION_CLOSED';
  }
  const binding = ctx.binding(event.tenantId);
  if (binding === undefined) {
    return 'TENANT_NOT_BOUND';
  }
  if (!registrationAdmits(binding, event.time, ctx.nowMs)) {
    return 'REGISTRATION_CLOSED';
  }
  const meter = ctx.meterAt(event.meterId, hourOf(event.time));
  if (meter === undefined || meter.status !== 'ACTIVE') {
    return 'UNKNOWN_METER';
  }
  const allowed = meter.allowedApplications ?? [];
  if (allowed.length > 0 && !allowed.includes(ctx.applicationId)) {
    return 'METER_NOT_ALLOWED';
  }
  return undefined;
}
