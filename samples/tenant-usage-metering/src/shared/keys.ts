// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Every key of the one table (spec §4). Builders only; no I/O. Keys are
 * built from values the model or the ingest checks already validated, and
 * none of those charsets contains `#`, so a key never splits ambiguously.
 */

import { createHash } from 'node:crypto';

export type Key = { PK: string; SK: string };

/** The attribute and value of the `list-by-type` index (one per listable kind). */
export type ListType = 'METER' | 'SINK' | 'EMITTER' | 'JOB';

export const keys = {
  meterCurrent: (meterId: string): Key => ({ PK: `METER#${meterId}`, SK: 'CURRENT' }),
  meterVersion: (meterId: string, version: number): Key => ({ PK: `METER#${meterId}`, SK: `V#${String(version).padStart(8, '0')}` }),
  meterPk: (meterId: string): string => `METER#${meterId}`,

  sink: (sinkId: string): Key => ({ PK: `SINK#${sinkId}`, SK: 'META' }),

  emitterRole: (accountId: string, roleName: string): Key => ({ PK: `ROLE#${accountId}#${roleName}`, SK: 'META' }),
  emitter: (emitterId: string): Key => ({ PK: `EMITTER#${emitterId}`, SK: 'META' }),

  binding: (emitterId: string, tenantId: string): Key => ({ PK: `EMITTER#${emitterId}`, SK: `TENANT#${tenantId}` }),
  bindingLookup: (tenantId: string, applicationId: string, emitterId: string): Key => ({
    PK: `TENANT#${tenantId}`,
    SK: `APP#${applicationId}#EMITTER#${emitterId}`,
  }),
  bindingLookupPrefix: (applicationId: string): string => `APP#${applicationId}#EMITTER#`,
  tenantPk: (tenantId: string): string => `TENANT#${tenantId}`,
  emitterPk: (emitterId: string): string => `EMITTER#${emitterId}`,

  hour: (hour: string): Key => ({ PK: `HOUR#${hour}`, SK: 'META' }),
  hourGeneration: (hour: string): Key => ({ PK: `HOUR#${hour}`, SK: 'GEN' }),

  job: (jobId: string): Key => ({ PK: `JOB#${jobId}`, SK: 'META' }),

  usagePk: (tenantId: string, applicationId: string): string => `USAGE#${tenantId}#${applicationId}`,
  usage: (tenantId: string, applicationId: string, hour: string, meterId: string, seq: number): Key => ({
    PK: `USAGE#${tenantId}#${applicationId}`,
    SK: `${hour}#${meterId}#${String(seq).padStart(4, '0')}`,
  }),

  /** Per-emitter admission counter of one minute (spec §3.2). */
  admission: (accountId: string, roleName: string, minute: string): Key => ({ PK: `RATE#${accountId}#${roleName}`, SK: `MIN#${minute}` }),
  /** Per-emitter stored-refusal counter of one hour (spec §3.2). */
  refusals: (accountId: string, roleName: string, hour: string): Key => ({ PK: `RATE#${accountId}#${roleName}`, SK: `REFUSED#${hour}` }),
};

export const PENDING = 1;

/** The sparse index of hours not yet `CLOSED` (spec §4.5). */
export const PENDING_HOURS_INDEX = 'pending-hours';
/** The sparse outbox index (spec §4.7). */
export const PUBLISH_OUTBOX_INDEX = 'publish-outbox';
/** `publishShard` takes values 0 to this minus one. */
export const PUBLISH_SHARDS = 4;
/** Meters (their `CURRENT` item), sinks, emitters and jobs, for the List operations. */
export const LIST_BY_TYPE_INDEX = 'list-by-type';

/** `sha256(tenantId, applicationId, meterId, hour, seq)` (spec §4.7). */
export function recordId(tenantId: string, applicationId: string, meterId: string, hour: string, seq: number): string {
  return createHash('sha256').update(JSON.stringify([tenantId, applicationId, meterId, hour, seq])).digest('hex');
}

/** The outbox shard of a record, `0` to `3` (spec §4.7). */
export function publishShard(id: string): number {
  return parseInt(id.slice(0, 2), 16) % PUBLISH_SHARDS;
}

/**
 * The ingest bus `DeduplicationId` of an event. The bus caps the id at 128
 * characters and `<applicationId>#<tenantId>#<eventId>` can reach 134, so the
 * key is hashed; the same key always gives the same id.
 */
export function ingestDeduplicationId(applicationId: string, tenantId: string, eventId: string): string {
  return createHash('sha256').update(`${applicationId}#${tenantId}#${eventId}`).digest('hex');
}
