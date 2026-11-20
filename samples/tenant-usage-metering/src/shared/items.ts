// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The table's item shapes (spec §4) and the pure lookups on them that the
 * ingest function, the admin API, the recounter and the dispatcher share.
 */

import type { Registration } from './usage-event';
import type { SumRule } from '../recount/rule';

export interface Audit {
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ControlPlaneIds {
  readonly controlPlaneExecutionId?: string;
  readonly controlPlaneOperatorId?: string;
  readonly closedByExecutionId?: string;
  readonly closedByOperatorId?: string;
}

export interface IntervalItem {
  readonly activeFrom: string;
  readonly closedAt: string;
  readonly closedByExecutionId?: string;
  readonly closedByOperatorId?: string;
}

/** `METER#<id>` / `V#<version>` (spec §4.1). */
export interface MeterVersionItem extends Audit {
  readonly PK: string;
  readonly SK: string;
  readonly meterId: string;
  readonly version: number;
  readonly unit: string;
  readonly rule: SumRule;
  readonly allowedApplications?: string[];
  readonly effectiveFrom: string;
  readonly status: 'ACTIVE' | 'RETIRED';
}

/** `METER#<id>` / `CURRENT`: the latest version number. */
export interface MeterCurrentItem {
  readonly PK: string;
  readonly SK: 'CURRENT';
  readonly meterId: string;
  readonly latest: number;
}

/** `EMITTER#<account>#<role>` / `META` (spec §4.2). */
export interface EmitterItem extends Audit, ControlPlaneIds, Registration {
  readonly PK: string;
  readonly SK: 'META';
  readonly cellId: string;
  readonly applicationId: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly intervals?: IntervalItem[];
  readonly expiresAt?: number;
}

/** `CELL#<cell>` / `META`: which emitter a cell has. A cell never moves. */
export interface CellItem {
  readonly PK: string;
  readonly SK: 'META';
  readonly cellId: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly applicationId: string;
  readonly expiresAt?: number;
}

/** `CELL#<cell>` / `TENANT#<tenant>` and its lookup copy (spec §4.3). */
export interface BindingItem extends Audit, ControlPlaneIds, Registration {
  readonly PK: string;
  readonly SK: string;
  readonly cellId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly billingAccount?: string;
  /** Set with a new billing account until its `RESEND_BLOCKED` job has started. */
  readonly resendPending?: boolean;
  readonly intervals?: IntervalItem[];
  readonly expiresAt?: number;
}

export type MappingSource = { recordField: string } | { meterField: string } | { constant: string };

/** `SINK#<id>` / `META` (spec §4.4). */
export interface SinkItem extends Audit {
  readonly PK: string;
  readonly SK: 'META';
  readonly sinkId: string;
  readonly type: 'HTTP' | 'S3_EXPORT';
  readonly enabled: boolean;
  readonly endpoint: string;
  /** `HTTP` only; absent is `SECRET`. Fixed at create. */
  readonly auth?: 'SECRET' | 'AWS_IAM';
  readonly secretName?: string;
  readonly mapping?: Record<string, MappingSource>;
  readonly meters?: string[];
  /** Moves on every write; `UpdateSink` is conditioned on it. */
  readonly version?: number;
}

export type HourStatus = 'OPEN' | 'COUNTING' | 'COUNTED' | 'DIRTY' | 'COUNT_FAILED' | 'CLOSED';

/** `HOUR#<hour>` / `META` (spec §4.5). */
export interface HourItem {
  readonly PK: string;
  readonly SK: 'META';
  readonly hour: string;
  readonly status: HourStatus;
  readonly countedGeneration?: number;
  readonly countedAt?: string;
  readonly lease?: string;
  readonly leaseExpiresAt?: string;
  readonly attempts: number;
  /** When a `COUNT_FAILED` hour may be taken again. */
  readonly retryAfter?: string;
  readonly pending?: number;
}

export type DeliveryState = { status: 'PENDING' | 'RETRYING' | 'SENT' | 'BLOCKED' | 'FAILED'; reason?: string };

/** `USAGE#<tenant>#<app>` / `<hour>#<meter>#<seq>` (spec §4.7). */
export interface UsageRecordItem {
  readonly PK: string;
  readonly SK: string;
  readonly recordId: string;
  readonly kind: 'HOURLY' | 'ADJUSTMENT';
  readonly tenantId: string;
  readonly applicationId: string;
  readonly meterId: string;
  readonly meterVersion: number;
  readonly unit: string;
  readonly hour: string;
  readonly seq: number;
  readonly revision: number;
  readonly quantity: string;
  readonly total: string;
  readonly eventCount: number;
  readonly billingAccount?: string;
  readonly publishPending?: string;
  readonly publishShard?: number;
  readonly sinks?: Record<string, DeliveryState>;
  readonly createdAt: string;
}

export type JobKind = 'RECOUNT' | 'READMIT' | 'INGEST_REDRIVE' | 'SINK_REDRIVE' | 'RESEND_BLOCKED';

export interface JobCounts {
  processed: number;
  admitted: number;
  refused: number;
  redriven: number;
}

/** `JOB#<id>` / `META` (spec §4.6). */
export interface JobItem extends Audit {
  readonly PK: string;
  readonly SK: 'META';
  readonly jobId: string;
  readonly kind: JobKind;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly counts: JobCounts;
  readonly from?: string;
  readonly to?: string;
  readonly reason?: string;
  readonly sinkId?: string;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly statusReason?: string;
  readonly updatedAt: string;
}

/** The message a delivery queue holds: one record for one sink (spec §4.7). */
export interface DeliveryMessage {
  readonly PK: string;
  readonly SK: string;
  readonly sinkId: string;
  /** When the first attempt was queued; the dispatcher gives up 24 h later. */
  readonly firstQueuedAt: string;
}

/**
 * The meter version in effect at an hour: the latest `effectiveFrom` at or
 * before it, the higher version on a tie (spec §4.1).
 */
export function versionAt(versions: ReadonlyArray<MeterVersionItem>, hour: string): MeterVersionItem | undefined {
  let best: MeterVersionItem | undefined;
  for (const version of versions) {
    if (version.effectiveFrom > hour) {
      continue;
    }
    if (
      best === undefined ||
      version.effectiveFrom > best.effectiveFrom ||
      (version.effectiveFrom === best.effectiveFrom && version.version > best.version)
    ) {
      best = version;
    }
  }
  return best;
}

/** The binding a record takes its billing account from: the `ACTIVE` one, else the latest `CLOSING` one (spec §4.7). */
export function billingBinding(bindings: ReadonlyArray<BindingItem>): BindingItem | undefined {
  const active = bindings.find((binding) => binding.status === 'ACTIVE');
  if (active !== undefined) {
    return active;
  }
  return [...bindings].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0];
}

/** Whether a sink takes a meter. */
export function sinkTakes(sink: Pick<SinkItem, 'meters'>, meterId: string): boolean {
  return sink.meters === undefined || sink.meters.length === 0 || sink.meters.includes(meterId);
}
