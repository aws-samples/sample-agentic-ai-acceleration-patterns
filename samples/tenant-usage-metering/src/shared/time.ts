// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Hour arithmetic (spec §3.3, §4.5). An hour key is `YYYY-MM-DDTHH`, UTC.
 */

import { hourEndMs, hourOf } from './usage-event';

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
/** A job refuses an hour this close to its close (spec §4.5). */
/**
 * Jobs refuse an hour this close to its close (spec §4.5): long enough for
 * the object tracker's retries (30 minutes of event age) and the scheduler's
 * replay of its failures to land before the hour can close.
 */
export const CLOSE_GUARD_MS = 60 * MINUTE_MS;
/** Ranges of jobs and usage reads span at most this many hours (spec §4.6). */
export const MAX_RANGE_HOURS = 744;

const HOUR_KEY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$/;

export function isHourKey(value: string): boolean {
  return HOUR_KEY.test(value) && !Number.isNaN(Date.parse(`${value}:00:00.000Z`)) && hourOf(`${value}:00:00.000Z`) === value;
}

export function hourStartMs(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`);
}

export function addHours(hour: string, count: number): string {
  return hourOf(new Date(hourStartMs(hour) + count * HOUR_MS));
}

/** The next whole hour after `nowMs` (spec §4.1). */
export function nextWholeHour(nowMs: number): string {
  return addHours(hourOf(new Date(nowMs)), 1);
}

/** The hours `from` to `to`, both inclusive. */
export function hoursBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = hourStartMs(from); at <= hourStartMs(to); at += HOUR_MS) {
    out.push(hourOf(new Date(at)));
  }
  return out;
}

/** The number of hours from `from` to `to`, or a negative number when `to` is earlier. */
export function hourSpan(from: string, to: string): number {
  return Math.round((hourStartMs(to) - hourStartMs(from)) / HOUR_MS);
}

/** When an hour closes: its end plus `recountWindowHours` (spec §4.5). */
export function closeTimeMs(hour: string, recountWindowHours: number): number {
  return hourEndMs(hour) + recountWindowHours * HOUR_MS;
}

/** Whether a job must refuse an hour: closed, or within 60 minutes of its close (spec §4.5). */
export function pastCloseGuard(hour: string, nowMs: number, recountWindowHours: number): boolean {
  return nowMs >= closeTimeMs(hour, recountWindowHours) - CLOSE_GUARD_MS;
}

/** A DynamoDB TTL value, epoch seconds. */
export function epochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The minute key of an instant, `YYYY-MM-DDTHH:MM`. */
export function minuteOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
