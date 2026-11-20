// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `READMIT` (spec §4.6, P-8): runs every refused event of the error objects
 * of an hour range through the ingest checks again, and writes those that
 * now pass to `readmitted/hour=<event hour>/` with their original
 * `receivedAt`; the recount reads them with `raw/`.
 *
 * Each event is judged as ingest would have judged it when it arrived: the
 * checks run with `receivedAt` as their clock, against the registrations
 * and meter versions as they stand now (the current interval or one of the
 * earlier `intervals`, and the meter version in effect at the event's hour).
 * The close guard then runs on the real clock before each object: an event
 * whose hour is closed or within 60 minutes of its close goes back to
 * `error/` as `TOO_LATE`.
 */

import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { JobStore } from './job-store';
import type { ErrorObject } from '../ingest/ingest';
import type { ObjectStore } from '../recount/count';
import { getItem, meterVersions } from '../shared/db';
import type { BindingItem, EmitterRoleItem, HourItem, JobCounts, JobItem, MeterVersionItem } from '../shared/items';
import { versionAt } from '../shared/items';
import { keys } from '../shared/keys';
import { hoursBetween, iso, pastCloseGuard } from '../shared/time';
import { checkEvent, type EnrichedUsageEvent, hourOf, READMITTABLE, type RefusalReason, type UsageEvent } from '../shared/usage-event';

export interface ReadmissionDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly objects: ObjectStore;
  readonly writeObject: (key: string, body: string) => Promise<void>;
  readonly recountWindowHours: number;
  readonly store: JobStore;
  readonly now?: () => number;
}

export class Readmission {
  private readonly now: () => number;

  constructor(private readonly deps: ReadmissionDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async hourClosed(hour: string): Promise<boolean> {
    if (pastCloseGuard(hour, this.now(), this.deps.recountWindowHours)) {
      return true;
    }
    const meta = await getItem<HourItem>(this.deps.db, this.deps.tableName, keys.hour(hour), true);
    return meta?.status === 'CLOSED';
  }

  async run(job: JobItem, counts: JobCounts, outOfTime: () => boolean): Promise<void> {
    const { db, tableName, objects, recountWindowHours } = this.deps;
    const versions = new Map<string, MeterVersionItem[]>();
    let sequence = 0;
    for (const receivedHour of hoursBetween(job.from!, job.to!)) {
      for (const key of await objects.list(`error/hour=${receivedHour}/`)) {
        if (outOfTime()) {
          return;
        }
        let object: ErrorObject;
        try {
          object = JSON.parse(await objects.read(key)) as ErrorObject;
        } catch {
          continue; // not a batch's error object (a TOO_LATE object of a job, say)
        }
        if (object.caller === undefined || !Array.isArray(object.events)) {
          continue;
        }
        const emitter = await getItem<EmitterRoleItem>(db, tableName, keys.emitterRole(object.caller.accountId, object.caller.roleName), true);
        const receivedAtMs = Date.parse(object.receivedAt);
        const byHour = new Map<string, EnrichedUsageEvent[]>();
        const tooLate: Array<{ index: number; reason: RefusalReason; event: unknown }> = [];
        for (const entry of object.events) {
          if (!READMITTABLE.has(entry.reason) || (job.reason !== undefined && entry.reason !== job.reason)) {
            continue;
          }
          counts.processed++;
          const event = entry.event as UsageEvent;
          if (emitter === undefined || emitter.emitterId !== object.caller.emitterId) {
            counts.refused++;
            continue;
          }
          const tenantId = typeof event?.tenantId === 'string' ? event.tenantId : '';
          const binding = tenantId.length > 0
            ? await getItem<BindingItem>(db, tableName, keys.binding(emitter.emitterId, tenantId), true)
            : undefined;
          const meterId = typeof event?.meterId === 'string' ? event.meterId : '';
          if (meterId.length > 0 && !versions.has(meterId)) {
            versions.set(meterId, await meterVersions(db, tableName, meterId, true));
          }
          const reason = checkEvent(event, {
            nowMs: receivedAtMs,
            recountWindowHours,
            applicationId: emitter.applicationId,
            emitter,
            binding: () => (binding !== undefined && binding.applicationId === emitter.applicationId ? binding : undefined),
            meterAt: (id, hour) => versionAt(versions.get(id) ?? [], hour),
          });
          if (reason !== undefined) {
            counts.refused++;
            continue;
          }
          const hour = hourOf(event.time);
          if (await this.hourClosed(hour)) {
            tooLate.push({ index: entry.index, reason: 'TOO_LATE', event: entry.event });
            counts.refused++;
            continue;
          }
          const list = byHour.get(hour) ?? [];
          list.push({
            eventId: event.eventId,
            tenantId: event.tenantId,
            meterId: event.meterId,
            value: event.value,
            time: event.time,
            ...(event.dimensions !== undefined ? { dimensions: event.dimensions } : {}),
            applicationId: emitter.applicationId,
            emitterId: emitter.emitterId,
            emitterAccountId: object.caller.accountId,
            emitterRole: object.caller.roleName,
            receivedAt: object.receivedAt,
          });
          byHour.set(hour, list);
        }
        for (const [hour, events] of byHour) {
          // The close guard runs again right before the write (spec §4.5).
          if (await this.hourClosed(hour)) {
            events.forEach((event) => tooLate.push({ index: -1, reason: 'TOO_LATE', event }));
            counts.refused += events.length;
            continue;
          }
          await this.deps.writeObject(`readmitted/hour=${hour}/${job.jobId}-${String(sequence++).padStart(6, '0')}.ndjson`, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
          counts.admitted += events.length;
        }
        if (tooLate.length > 0) {
          const nowMs = this.now();
          const body: ErrorObject = { caller: object.caller, receivedAt: object.receivedAt, requestId: job.jobId, events: tooLate };
          await this.deps.writeObject(`error/hour=${hourOf(new Date(nowMs))}/${iso(nowMs).replace(/[-:.]/g, '')}-${job.jobId}-${sequence++}.json`, JSON.stringify(body));
        }
      }
      await this.deps.store.progress(job, counts);
    }
  }
}

