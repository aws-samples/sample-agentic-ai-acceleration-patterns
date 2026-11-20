// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registration lifecycle shared by emitters and bindings (spec §4.2,
 * §4.3): none → `ACTIVE` → `CLOSING` → removed by TTL, and back to `ACTIVE`
 * when the control plane creates the same key again. Pure: it computes the
 * attributes a transition writes; the callers make the conditional writes.
 */

import type { ControlPlaneIds, IntervalItem } from './items';
import { epochSeconds, HOUR_MS, iso, MINUTE_MS } from './time';
import { hourEndMs, hourOf, type Registration } from './usage-event';

export interface StoredRegistration extends Registration, ControlPlaneIds {
  readonly intervals?: IntervalItem[];
}

export interface Trace {
  readonly executionId?: string;
  readonly operatorId?: string;
}

/** When a closed interval stops mattering: the end of its `closedAt` hour plus the recount window. */
export function intervalExpiryMs(closedAt: string, recountWindowHours: number): number {
  return hourEndMs(hourOf(closedAt)) + recountWindowHours * HOUR_MS;
}

/** The attributes `Delete*` sets on an `ACTIVE` registration. */
export function closeAttributes(nowMs: number, closeGraceMinutes: number, recountWindowHours: number, trace: Trace): Record<string, string | number> {
  const closedAt = iso(nowMs);
  return {
    status: 'CLOSING',
    closedAt,
    closesAt: iso(nowMs + closeGraceMinutes * MINUTE_MS),
    expiresAt: epochSeconds(intervalExpiryMs(closedAt, recountWindowHours)),
    ...(trace.executionId !== undefined ? { closedByExecutionId: trace.executionId } : {}),
    ...(trace.operatorId !== undefined ? { closedByOperatorId: trace.operatorId } : {}),
  };
}

/**
 * What `Put*` writes on a `CLOSING` registration: the closed interval moves
 * into `intervals` (with its `closedBy*` pair), intervals past the recount
 * window are dropped, and a new `activeFrom` starts.
 */
export function reactivation(stored: StoredRegistration, nowMs: number, recountWindowHours: number, trace: Trace): {
  set: Record<string, unknown>;
  remove: string[];
} {
  const closed: IntervalItem = {
    activeFrom: stored.activeFrom,
    closedAt: stored.closedAt ?? iso(nowMs),
    ...(stored.closedByExecutionId !== undefined ? { closedByExecutionId: stored.closedByExecutionId } : {}),
    ...(stored.closedByOperatorId !== undefined ? { closedByOperatorId: stored.closedByOperatorId } : {}),
  };
  const intervals = [...(stored.intervals ?? []), closed].filter((interval) => intervalExpiryMs(interval.closedAt, recountWindowHours) > nowMs);
  const set: Record<string, unknown> = { status: 'ACTIVE', activeFrom: iso(nowMs), intervals };
  const remove = ['closedAt', 'closesAt', 'expiresAt', 'closedByExecutionId', 'closedByOperatorId'];
  if (trace.executionId !== undefined) {
    set.controlPlaneExecutionId = trace.executionId;
  } else {
    remove.push('controlPlaneExecutionId');
  }
  if (trace.operatorId !== undefined) {
    set.controlPlaneOperatorId = trace.operatorId;
  } else {
    remove.push('controlPlaneOperatorId');
  }
  return { set, remove };
}

/** An `UpdateExpression` with its names and values from a set/remove pair. */
export function updateExpression(set: Record<string, unknown>, remove: ReadonlyArray<string> = []): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries(set).map(([name, value], i) => {
    names[`#s${i}`] = name;
    values[`:s${i}`] = value;
    return `#s${i} = :s${i}`;
  });
  const removes = remove.map((name, i) => {
    names[`#r${i}`] = name;
    return `#r${i}`;
  });
  const parts = [sets.length > 0 ? `SET ${sets.join(', ')}` : '', removes.length > 0 ? `REMOVE ${removes.join(', ')}` : ''].filter((part) => part.length > 0);
  return { UpdateExpression: parts.join(' '), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}
