// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Reads the enriched events out of a stored object, whatever format it was
 * written in (spec §4.8): concatenated EventBridge envelopes (`BUS`),
 * concatenated packed records (`DIRECT`) or newline-delimited events
 * (`readmitted/`). An event that is not a well-formed enriched event, or
 * that belongs to another hour, is skipped and counted.
 */

import { splitConcatenatedJson } from '../shared/json-stream';
import { type EnrichedUsageEvent, hourOf, shapeIsValid } from '../shared/usage-event';

const ENRICHMENT = ['applicationId', 'cellId', 'emitterAccountId', 'emitterRole', 'receivedAt'] as const;

export function asEnrichedEvent(value: unknown): EnrichedUsageEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const name of ['eventId', 'tenantId', 'meterId', 'value', 'time', 'dimensions']) {
    if (record[name] !== undefined) {
      body[name] = record[name];
    }
  }
  if (!shapeIsValid(body)) {
    return undefined;
  }
  for (const name of ENRICHMENT) {
    if (typeof record[name] !== 'string' || (record[name] as string).length === 0) {
      return undefined;
    }
  }
  if (Number.isNaN(Date.parse(record.receivedAt as string))) {
    return undefined;
  }
  return value as EnrichedUsageEvent;
}

/** The events of one object that belong to `hour`, and how many values were skipped. */
export function eventsOfObject(text: string, hour: string): { events: EnrichedUsageEvent[]; skipped: number } {
  const { values, malformed } = splitConcatenatedJson(text);
  const events: EnrichedUsageEvent[] = [];
  let skipped = malformed;
  const take = (value: unknown) => {
    const event = asEnrichedEvent(value);
    if (event === undefined || hourOf(event.time) !== hour) {
      skipped++;
    } else {
      events.push(event);
    }
  };
  for (const value of values) {
    const record = value as Record<string, unknown> | null;
    if (record !== null && typeof record === 'object' && !Array.isArray(record) && typeof record.detail === 'object' && record.detail !== null) {
      take(record.detail);
    } else if (record !== null && typeof record === 'object' && !Array.isArray(record) && Array.isArray(record.events)) {
      record.events.forEach(take);
    } else {
      take(value);
    }
  }
  return { events, skipped };
}
