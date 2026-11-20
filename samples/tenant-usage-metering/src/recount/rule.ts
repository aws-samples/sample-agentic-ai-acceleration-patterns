// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { canonicalJson } from '../shared/canonical-json';
import { countMicros, formatMicros, parseQuantity, parseValue } from '../shared/decimal';
import type { EnrichedUsageEvent } from '../shared/usage-event';

/**
 * The recount rule (spec §4.9, ADR-0003): a pure function from one hour's
 * stored events and the records already written to the records still to
 * write. The same inputs always give the same output, so a recount of a
 * counted hour with no new object writes nothing (spec P-4).
 */

export type SumRule = 'COUNT' | 'SUM' | 'MAX' | 'UNIQUE_COUNT';

export interface MeterVersion {
  readonly meterId: string;
  readonly version: number;
  readonly rule: SumRule;
}

/** An existing record of the hour, as the table holds it (spec §4.7). */
export interface ExistingRecord {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly meterId: string;
  readonly seq: number;
  readonly quantity: string;
}

/** A record the recount must write. */
export interface NewRecord {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly meterId: string;
  readonly meterVersion: number;
  readonly hour: string;
  readonly seq: number;
  readonly kind: 'HOURLY' | 'ADJUSTMENT';
  readonly quantity: string;
  readonly total: string;
  readonly eventCount: number;
}

/** Dedupe key: the verified application, the tenant and the event id (P-5). */
export function dedupeKey(event: Pick<EnrichedUsageEvent, 'applicationId' | 'tenantId' | 'eventId'>): string {
  return `${event.applicationId}#${event.tenantId}#${event.eventId}`;
}

/**
 * Keeps one event per dedupe key: the earliest `receivedAt`, ties broken by
 * the lowest canonical JSON of the enriched event (spec §4.9 step 1).
 */
export function dedupe(events: Iterable<EnrichedUsageEvent>): EnrichedUsageEvent[] {
  const winners = new Map<string, { event: EnrichedUsageEvent; at: number; canonical: string }>();
  for (const event of events) {
    const key = dedupeKey(event);
    const at = Date.parse(event.receivedAt);
    const current = winners.get(key);
    if (current === undefined || at < current.at) {
      winners.set(key, { event, at, canonical: canonicalJson(event) });
      continue;
    }
    if (at === current.at) {
      const canonical = canonicalJson(event);
      if (canonical < current.canonical) {
        winners.set(key, { event, at, canonical });
      }
    }
  }
  return [...winners.values()].map((winner) => winner.event);
}

/** One group's total in micro-units under its rule (spec §4.9 step 2). */
export function total(rule: SumRule, events: ReadonlyArray<EnrichedUsageEvent>): bigint {
  switch (rule) {
    case 'COUNT':
      return countMicros(events.length);
    case 'SUM':
      return events.reduce((sum, event) => sum + parseValue(event.value), 0n);
    case 'MAX':
      return events.reduce((max, event) => {
        const value = parseValue(event.value);
        return value > max ? value : max;
      }, 0n);
    case 'UNIQUE_COUNT':
      return countMicros(new Set(events.map((event) => event.value)).size);
  }
}

const groupKey = (tenantId: string, applicationId: string, meterId: string): string =>
  `${tenantId}\u0000${applicationId}\u0000${meterId}`;

/**
 * The records to write for one hour (spec §4.9 step 3): for each group, the
 * difference between its total and the sum of its existing records, as
 * `HOURLY` (seq 0) when none exists, else `ADJUSTMENT`. A group whose meter
 * has no version in effect at the hour is skipped; ingest refused those.
 */
export function recountHour(
  hour: string,
  events: Iterable<EnrichedUsageEvent>,
  existing: ReadonlyArray<ExistingRecord>,
  meterAt: (meterId: string) => MeterVersion | undefined,
): NewRecord[] {
  const groups = new Map<string, EnrichedUsageEvent[]>();
  for (const event of dedupe(events)) {
    const key = groupKey(event.tenantId, event.applicationId, event.meterId);
    const list = groups.get(key);
    if (list === undefined) {
      groups.set(key, [event]);
    } else {
      list.push(event);
    }
  }

  const written = new Map<string, { sum: bigint; nextSeq: number }>();
  for (const record of existing) {
    const key = groupKey(record.tenantId, record.applicationId, record.meterId);
    const current = written.get(key) ?? { sum: 0n, nextSeq: 0 };
    written.set(key, {
      sum: current.sum + parseQuantity(record.quantity),
      nextSeq: Math.max(current.nextSeq, record.seq + 1),
    });
  }

  const out: NewRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const { tenantId, applicationId, meterId } = group[0];
    const meter = meterAt(meterId);
    if (meter === undefined) {
      continue;
    }
    const groupTotal = total(meter.rule, group);
    const prior = written.get(key);
    if (prior === undefined) {
      out.push({
        tenantId,
        applicationId,
        meterId,
        meterVersion: meter.version,
        hour,
        seq: 0,
        kind: 'HOURLY',
        quantity: formatMicros(groupTotal),
        total: formatMicros(groupTotal),
        eventCount: group.length,
      });
      continue;
    }
    const difference = groupTotal - prior.sum;
    if (difference === 0n) {
      continue;
    }
    out.push({
      tenantId,
      applicationId,
      meterId,
      meterVersion: meter.version,
      hour,
      seq: prior.nextSeq,
      kind: 'ADJUSTMENT',
      quantity: formatMicros(difference),
      total: formatMicros(groupTotal),
      eventCount: group.length,
    });
  }
  return out;
}
