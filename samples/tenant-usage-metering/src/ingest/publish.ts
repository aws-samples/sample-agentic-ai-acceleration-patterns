// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Where the ingest function puts accepted events (ADR-0002): the ingest bus
 * (`ingestPath: BUS`) or Firehose directly, packed per hour (`DIRECT`).
 * Each publisher retries throttled entries a few times inside the request
 * and reports which events it stored; the rest go back to the emitter as
 * `RETRY` (spec §5).
 */

import { type EventBridgeV2Client, PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridgev2';
import { type FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import { ingestDeduplicationId } from '../shared/keys';
import { backoffMs, sleep } from '../shared/retry';
import { hourOf, type EnrichedUsageEvent } from '../shared/usage-event';

/** Stores events; resolves to the indexes that were stored (or were already stored). */
export type EventPublisher = (events: ReadonlyArray<EnrichedUsageEvent>) => Promise<Set<number>>;

export const INGEST_SOURCE = 'metering.ingest';
export const INGEST_DETAIL_TYPE = 'UsageEvent';

/** Entries per `PutEvents` call, and the request size the publisher stays under. */
const BUS_MAX_ENTRIES = 100;
const BUS_MAX_BYTES = 240 * 1024;
const ATTEMPTS = 4;

export function busEntry(event: EnrichedUsageEvent): PutEventsRequestEntry {
  return {
    Source: INGEST_SOURCE,
    DetailType: INGEST_DETAIL_TYPE,
    Detail: JSON.stringify(event),
    SystemMetadata: {
      DeduplicationId: ingestDeduplicationId(event.applicationId, event.tenantId, event.eventId),
      EventGroupId: event.tenantId,
    },
  };
}

/** Splits entries into `PutEvents` calls by count and size. */
export function busBatches<T>(
  items: ReadonlyArray<T>,
  size: (item: T) => number,
  maxEntries = BUS_MAX_ENTRIES,
  maxBytes = BUS_MAX_BYTES,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    if (current.length > 0 && (current.length >= maxEntries || bytes + itemBytes > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

export function busPublisher(client: EventBridgeV2Client, busArn: string): EventPublisher {
  return async (events) => {
    const stored = new Set<number>();
    const indexed = events.map((event, index) => ({ index, entry: busEntry(event) }));
    const sizeOf = (item: { entry: PutEventsRequestEntry }) =>
      Buffer.byteLength(item.entry.Detail ?? '') + item.entry.Source!.length + item.entry.DetailType!.length + 200;
    for (const batch of busBatches(indexed, sizeOf)) {
      let pending = batch;
      for (let attempt = 0; attempt < ATTEMPTS && pending.length > 0; attempt++) {
        if (attempt > 0) {
          await sleep(100 * 2 ** (attempt - 1) + backoffMs(attempt));
        }
        try {
          const out = await client.send(new PutEventsCommand({ EventBusArn: busArn, Entries: pending.map((item) => item.entry) }));
          const results = out.Entries ?? [];
          const retry: typeof pending = [];
          pending.forEach((item, i) => {
            const code = results[i]?.SuccessCode;
            if (code === 'PUBLISHED' || code === 'DEDUPLICATED') {
              stored.add(item.index);
            } else {
              retry.push(item);
            }
          });
          pending = retry;
        } catch (error) {
          if (attempt + 1 >= ATTEMPTS) {
            break;
          }
          void error;
        }
      }
    }
    return stored;
  };
}

/** A `DIRECT` Firehose record: the events of one batch that share an hour (spec §4.8). */
export interface PackedRecord {
  readonly hour: string;
  readonly events: EnrichedUsageEvent[];
}

export function packByHour(events: ReadonlyArray<EnrichedUsageEvent>): Array<{ record: PackedRecord; indexes: number[] }> {
  const groups = new Map<string, { record: PackedRecord; indexes: number[] }>();
  events.forEach((event, index) => {
    const hour = hourOf(event.time);
    const group = groups.get(hour) ?? { record: { hour, events: [] }, indexes: [] };
    group.record.events.push(event);
    group.indexes.push(index);
    groups.set(hour, group);
  });
  return [...groups.values()];
}

/** Puts records into Firehose with retries of the failed ones; resolves to the indexes stored. */
export async function putFirehoseRecords(
  client: FirehoseClient,
  streamName: string,
  records: ReadonlyArray<Uint8Array>,
): Promise<Set<number>> {
  const stored = new Set<number>();
  let pending = records.map((data, index) => ({ data, index }));
  for (let attempt = 0; attempt < ATTEMPTS && pending.length > 0; attempt++) {
    if (attempt > 0) {
      await sleep(100 * 2 ** (attempt - 1) + backoffMs(attempt));
    }
    try {
      const out = await client.send(
        new PutRecordBatchCommand({ DeliveryStreamName: streamName, Records: pending.map((item) => ({ Data: item.data })) }),
      );
      const responses = out.RequestResponses ?? [];
      const retry: typeof pending = [];
      pending.forEach((item, i) => {
        if (responses[i]?.ErrorCode === undefined && responses[i]?.RecordId !== undefined) {
          stored.add(item.index);
        } else {
          retry.push(item);
        }
      });
      pending = retry;
    } catch (error) {
      void error;
    }
  }
  return stored;
}

export function directPublisher(client: FirehoseClient, streamName: string): EventPublisher {
  return async (events) => {
    const packed = packByHour(events);
    const done = await putFirehoseRecords(
      client,
      streamName,
      packed.map((group) => Buffer.from(JSON.stringify(group.record))),
    );
    const stored = new Set<number>();
    packed.forEach((group, i) => {
      if (done.has(i)) {
        group.indexes.forEach((index) => stored.add(index));
      }
    });
    return stored;
  };
}
