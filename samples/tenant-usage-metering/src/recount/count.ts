// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One recount of one hour (spec §4.5, §4.9; ADR-0003), the work of a
 * recounter execution:
 *
 * 1. take the hour: a conditional write to `COUNTING` with the execution's
 *    lease, from `OPEN` past its grace, `DIRTY`, `COUNT_FAILED` past its
 *    backoff, or `COUNTING` with a lapsed lease (which counts as a failure);
 * 2. read `generation`, then every object of the hour;
 * 3. run the recount rule against the records already written;
 * 4. write the new records in transactions fenced on the lease;
 * 5. finish: `COUNTED` if `generation` has not moved, else `DIRTY`.
 *
 * A step that finds the lease gone stops and writes nothing more.
 */

import { TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { recountHour, type ExistingRecord, type NewRecord } from './rule';
import { eventsOfObject } from './stored-events';
import { allSinks, getItem, meterVersions, queryAll, tenantBindings } from '../shared/db';
import { billingBinding, type DeliveryState, type HourItem, sinkTakes, type SinkItem, type UsageRecordItem, versionAt, type MeterVersionItem } from '../shared/items';
import { keys, publishShard, recordId } from '../shared/keys';
import { log } from '../shared/logger';
import { METRIC, type Metrics } from '../shared/metrics';
import { cancellationCodes, chunk, isConditionFailure, mapLimit, withRetry } from '../shared/retry';
import { iso, MINUTE_MS } from '../shared/time';
import { type EnrichedUsageEvent, hourEndMs } from '../shared/usage-event';

/** A lease outlives the execution's 25-minute timeout (spec §4.5). */
export const LEASE_MS = 30 * MINUTE_MS;
/** Records per transaction, plus the lease check. */
const RECORDS_PER_TRANSACTION = 99;
/** An alarm fires on the third failed count in a row (spec §4.5). */
export const FAILURES_BEFORE_ALARM = 3;

export interface ObjectStore {
  list(prefix: string): Promise<string[]>;
  read(key: string): Promise<string>;
}

export interface RecountDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly objects: ObjectStore;
  readonly lateGraceMinutes: number;
  readonly metrics: Metrics;
  readonly now?: () => number;
}

export type RecountOutcome = 'NOT_DUE' | 'COUNTED' | 'DIRTY' | 'LOST_LEASE';

/** Backoff of a failed count: 2^attempts minutes, at most an hour. */
export function retryBackoffMs(attempts: number): number {
  return Math.min(60, 2 ** attempts) * MINUTE_MS;
}

/** Whether a hour in this state may be taken now, and whether taking it takes over a lapsed lease. */
export function takeable(item: HourItem, nowMs: number, lateGraceMinutes: number): { take: boolean; takeover: boolean } {
  switch (item.status) {
    case 'OPEN':
      return { take: nowMs >= hourEndMs(item.hour) + lateGraceMinutes * MINUTE_MS, takeover: false };
    case 'DIRTY':
      return { take: true, takeover: false };
    case 'COUNT_FAILED':
      return { take: item.retryAfter === undefined || Date.parse(item.retryAfter) <= nowMs, takeover: false };
    case 'COUNTING':
      return { take: item.leaseExpiresAt === undefined || Date.parse(item.leaseExpiresAt) < nowMs, takeover: true };
    default:
      return { take: false, takeover: false };
  }
}

export class Recount {
  private readonly now: () => number;

  constructor(private readonly deps: RecountDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(hour: string, lease: string): Promise<RecountOutcome> {
    if (!(await this.take(hour, lease))) {
      return 'NOT_DUE';
    }
    const gen = await getItem<{ generation?: number }>(this.deps.db, this.deps.tableName, keys.hourGeneration(hour), true);
    const generation = Number(gen?.generation ?? 0);
    const events = await this.readEvents(hour);
    const records = await this.recordsToWrite(hour, events);
    if (!(await this.write(hour, lease, records))) {
      this.deps.metrics.add(METRIC.recountLostLease);
      return 'LOST_LEASE';
    }
    this.deps.metrics.add(METRIC.recordsWritten, records.length);
    const outcome = await this.finish(hour, lease, generation);
    log.info('hour counted', { hour, status: outcome, count: events.length, generation });
    return outcome;
  }

  /** Step 1. */
  private async take(hour: string, lease: string): Promise<boolean> {
    const nowMs = this.now();
    const item = await getItem<HourItem>(this.deps.db, this.deps.tableName, keys.hour(hour), true);
    if (item === undefined) {
      return false;
    }
    const { take, takeover } = takeable(item, nowMs, this.deps.lateGraceMinutes);
    if (!take) {
      return false;
    }
    const attempts = (item.attempts ?? 0) + (takeover ? 1 : 0);
    const seen: Record<string, unknown> = { ':seen': item.status };
    let condition = '#s = :seen';
    if (item.status === 'COUNTING') {
      condition += item.lease === undefined ? ' AND attribute_not_exists(lease)' : ' AND lease = :seenLease';
      if (item.lease !== undefined) {
        seen[':seenLease'] = item.lease;
      }
    }
    try {
      await withRetry(() =>
        this.deps.db.send(
          new UpdateCommand({
            TableName: this.deps.tableName,
            Key: keys.hour(hour),
            UpdateExpression: 'SET #s = :counting, lease = :lease, leaseExpiresAt = :exp, attempts = :attempts REMOVE retryAfter',
            ConditionExpression: condition,
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ...seen, ':counting': 'COUNTING', ':lease': lease, ':exp': iso(nowMs + LEASE_MS), ':attempts': attempts },
          }),
        ),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        return false;
      }
      throw error;
    }
    if (takeover) {
      this.deps.metrics.add(METRIC.recountFailed);
      if (attempts >= FAILURES_BEFORE_ALARM) {
        this.deps.metrics.add(METRIC.recountFailedThrice);
      }
    }
    return true;
  }

  /** Step 2. */
  private async readEvents(hour: string): Promise<EnrichedUsageEvent[]> {
    const objectKeys = [...(await this.deps.objects.list(`raw/hour=${hour}/`)), ...(await this.deps.objects.list(`readmitted/hour=${hour}/`))];
    const parts = await mapLimit(objectKeys, 16, async (key) => eventsOfObject(await this.deps.objects.read(key), hour));
    const skipped = parts.reduce((sum, part) => sum + part.skipped, 0);
    if (skipped > 0) {
      this.deps.metrics.add(METRIC.malformedStoredEvent, skipped);
      log.warn('stored values skipped', { hour, count: skipped });
    }
    return parts.flatMap((part) => part.events);
  }

  /** Step 3, plus what each new record carries besides its count. */
  private async recordsToWrite(hour: string, events: EnrichedUsageEvent[]): Promise<UsageRecordItem[]> {
    const { db, tableName } = this.deps;
    const meterIds = [...new Set(events.map((event) => event.meterId))];
    const versions = new Map<string, MeterVersionItem | undefined>();
    await mapLimit(meterIds, 8, async (meterId) => {
      const version = versionAt(await meterVersions(db, tableName, meterId, true), hour);
      versions.set(meterId, version !== undefined && version.status === 'ACTIVE' ? version : undefined);
    });

    const pairs = [...new Set(events.map((event) => `${event.tenantId}\u0000${event.applicationId}`))].map((pair) => pair.split('\u0000'));
    const existing: ExistingRecord[] = [];
    await mapLimit(pairs, 16, async ([tenantId, applicationId]) => {
      const items = await queryAll<UsageRecordItem>(db, {
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :h)',
        ExpressionAttributeValues: { ':pk': keys.usagePk(tenantId, applicationId), ':h': `${hour}#` },
        ConsistentRead: true,
      });
      existing.push(...items.map((item) => ({ tenantId, applicationId, meterId: item.meterId, seq: item.seq, quantity: item.quantity })));
    });

    const fresh: NewRecord[] = recountHour(hour, events, existing, (meterId) => {
      const version = versions.get(meterId);
      return version === undefined ? undefined : { meterId, version: version.version, rule: version.rule };
    });
    if (fresh.length === 0) {
      return [];
    }

    const sinks: SinkItem[] = (await allSinks(db, tableName)).filter((sink) => sink.enabled);
    const billing = new Map<string, string | undefined>();
    for (const [tenantId, applicationId] of pairs) {
      billing.set(`${tenantId}#${applicationId}`, billingBinding(await tenantBindings(db, tableName, tenantId, applicationId, true))?.billingAccount);
    }
    const nowIso = iso(this.now());
    return fresh.map((record) => {
      const id = recordId(record.tenantId, record.applicationId, record.meterId, hour, record.seq);
      const deliveries: Record<string, DeliveryState> = {};
      for (const sink of sinks) {
        if (sinkTakes(sink, record.meterId)) {
          deliveries[sink.sinkId] = { status: 'PENDING' };
        }
      }
      return {
        ...keys.usage(record.tenantId, record.applicationId, hour, record.meterId, record.seq),
        recordId: id,
        kind: record.kind,
        tenantId: record.tenantId,
        applicationId: record.applicationId,
        meterId: record.meterId,
        meterVersion: record.meterVersion,
        unit: versions.get(record.meterId)!.unit,
        hour,
        seq: record.seq,
        revision: 1,
        quantity: record.quantity,
        total: record.total,
        eventCount: record.eventCount,
        billingAccount: billing.get(`${record.tenantId}#${record.applicationId}`),
        publishPending: nowIso,
        publishShard: publishShard(id),
        sinks: deliveries,
        createdAt: nowIso,
      };
    });
  }

  /** Step 4: false when the lease was lost. */
  private async write(hour: string, lease: string, records: UsageRecordItem[]): Promise<boolean> {
    for (const batch of chunk(records, RECORDS_PER_TRANSACTION)) {
      try {
        await withRetry(() =>
          this.deps.db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: this.deps.tableName,
                    Key: keys.hour(hour),
                    ConditionExpression: '#s = :counting AND lease = :lease',
                    ExpressionAttributeNames: { '#s': 'status' },
                    ExpressionAttributeValues: { ':counting': 'COUNTING', ':lease': lease },
                  },
                },
                ...batch.map((record) => ({ Put: { TableName: this.deps.tableName, Item: record, ConditionExpression: 'attribute_not_exists(SK)' } })),
              ],
            }),
          ),
        );
      } catch (error) {
        const codes = cancellationCodes(error);
        if (codes[0] === 'ConditionalCheckFailed') {
          return false;
        }
        throw error;
      }
    }
    return true;
  }

  /** Step 5. */
  private async finish(hour: string, lease: string, generation: number): Promise<RecountOutcome> {
    const { db, tableName } = this.deps;
    try {
      await withRetry(() =>
        db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tableName,
                  Key: keys.hourGeneration(hour),
                  ConditionExpression: generation === 0 ? 'attribute_not_exists(generation) OR generation = :g' : 'generation = :g',
                  ExpressionAttributeValues: { ':g': generation },
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: keys.hour(hour),
                  UpdateExpression: 'SET #s = :counted, countedGeneration = :g, countedAt = :at, attempts = :zero REMOVE lease, leaseExpiresAt',
                  ConditionExpression: 'lease = :lease',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':counted': 'COUNTED', ':g': generation, ':at': iso(this.now()), ':zero': 0, ':lease': lease },
                },
              },
            ],
          }),
        ),
      );
      this.deps.metrics.add(METRIC.hourCounted);
      return 'COUNTED';
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes[1] === 'ConditionalCheckFailed') {
        return 'LOST_LEASE';
      }
      if (codes[0] !== 'ConditionalCheckFailed') {
        throw error;
      }
    }
    // An object landed during the count: count again next time.
    try {
      await withRetry(() =>
        db.send(
          new UpdateCommand({
            TableName: tableName,
            Key: keys.hour(hour),
            UpdateExpression: 'SET #s = :dirty REMOVE lease, leaseExpiresAt',
            ConditionExpression: 'lease = :lease',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':dirty': 'DIRTY', ':lease': lease },
          }),
        ),
      );
      return 'DIRTY';
    } catch (error) {
      if (isConditionFailure(error)) {
        return 'LOST_LEASE';
      }
      throw error;
    }
  }

  /** The failure path of an execution: `COUNT_FAILED` with backoff, if it still holds the lease. */
  async fail(hour: string, lease: string): Promise<void> {
    const { db, tableName } = this.deps;
    const item = await getItem<HourItem>(db, tableName, keys.hour(hour), true);
    if (item === undefined || item.lease !== lease) {
      return;
    }
    const attempts = (item.attempts ?? 0) + 1;
    try {
      await withRetry(() =>
        db.send(
          new UpdateCommand({
            TableName: tableName,
            Key: keys.hour(hour),
            UpdateExpression: 'SET #s = :failed, attempts = :attempts, retryAfter = :after REMOVE lease, leaseExpiresAt',
            ConditionExpression: 'lease = :lease',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':failed': 'COUNT_FAILED', ':attempts': attempts, ':after': iso(this.now() + retryBackoffMs(attempts)), ':lease': lease },
          }),
        ),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        return;
      }
      throw error;
    }
    this.deps.metrics.add(METRIC.recountFailed);
    if (attempts >= FAILURES_BEFORE_ALARM) {
      this.deps.metrics.add(METRIC.recountFailedThrice);
    }
    log.warn('hour count failed', { hour, attempt: attempts });
  }
}

