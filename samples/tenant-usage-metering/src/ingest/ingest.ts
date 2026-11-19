// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingest door (spec §3.1, §3.2, §4.8, §5; ADR-0001, ADR-0002).
 *
 * Identity comes from the verified caller only (P-2): the caller ARN API
 * Gateway hands over is reduced to an emitter role, and the registry decides
 * whether it is a registered, admitted emitter. Each event is then checked
 * alone: the per-emitter admission limit, the shape, the time, the emitter's
 * and the binding's intervals, and the meter in effect at its hour. Accepted
 * events are enriched with the caller's identity and stored; refused ones
 * go to the error store with their reason (P-8).
 */

import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventPublisher } from './publish';
import { TtlCache } from '../shared/cache';
import { getItem, meterVersions } from '../shared/db';
import { emitterFromCallerArn, type EmitterCaller, roleFromCallerArn } from '../shared/identity';
import { type BindingItem, type EmitterItem, versionAt, type MeterVersionItem } from '../shared/items';
import { keys } from '../shared/keys';
import { log } from '../shared/logger';
import { METRIC, Metrics } from '../shared/metrics';
import { withRetry } from '../shared/retry';
import { epochSeconds, HOUR_MS, iso, MINUTE_MS, minuteOf } from '../shared/time';
import {
  checkEvent,
  type EnrichedUsageEvent,
  hourOf,
  READMITTABLE,
  type RefusalReason,
  shapeIsValid,
  type UsageEvent,
} from '../shared/usage-event';

export const MAX_BODY_BYTES = 1_048_576;
export const REGISTRY_CACHE_MS = 60_000;
/** An uncached re-read of one key happens at most this often: short enough that a fresh registration admits at once. */
export const FRESH_READ_MS = 5_000;

export interface IngestConfig {
  readonly fleetName: string;
  readonly tableName: string;
  readonly recountWindowHours: number;
  readonly maxEventsPerEmitterPerMinute: number;
  readonly maxRefusedPerEmitterPerHour: number;
}

export interface IngestDeps {
  readonly db: DynamoDBDocumentClient;
  readonly config: IngestConfig;
  readonly publish: EventPublisher;
  readonly writeErrorObject: (key: string, body: string) => Promise<void>;
  readonly now?: () => number;
}

export type EventOutcome = { result: 'ACCEPTED' } | { result: 'RETRY' } | { result: 'REFUSED'; reason: RefusalReason };

export interface AdmittedEmitter {
  readonly caller: EmitterCaller;
  readonly emitter: EmitterItem;
}

/** The error object of one batch (spec §4.8). */
export interface ErrorObject {
  readonly caller: { accountId: string; roleName: string; cellId: string; applicationId: string };
  readonly receivedAt: string;
  readonly requestId: string;
  readonly events: Array<{ index: number; reason: RefusalReason; event: unknown }>;
}

export function errorObjectKey(receivedAtMs: number, requestId: string): string {
  const hour = hourOf(new Date(receivedAtMs));
  const stamp = iso(receivedAtMs).replace(/[-:.]/g, '');
  return `error/hour=${hour}/${stamp}-${requestId.replace(/[^A-Za-z0-9-]/g, '')}.json`;
}

export class Ingest {
  private readonly emitters = new TtlCache<EmitterItem | undefined>(REGISTRY_CACHE_MS);
  private readonly bindings = new TtlCache<BindingItem | undefined>(REGISTRY_CACHE_MS);
  private readonly meters = new TtlCache<MeterVersionItem[]>(REGISTRY_CACHE_MS);
  private readonly logged = new Map<string, number>();
  /** When each key was last read past the cache: at most once per FRESH_READ_MS. */
  private readonly freshAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: IngestDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The registered, admitted emitter behind a caller ARN, or `undefined`
   * (403 for the whole batch, spec §3.2). Unregistered callers are counted,
   * logged at most once a minute per ARN, and nothing is stored.
   */
  async admit(userArn: string | undefined, metrics: Metrics): Promise<AdmittedEmitter | undefined> {
    const caller = emitterFromCallerArn(userArn, this.deps.config.fleetName);
    const emitter = caller === undefined ? undefined : await this.emitter(caller);
    const nowMs = this.now();
    const closed =
      emitter !== undefined && emitter.status === 'CLOSING' && emitter.closesAt !== undefined && nowMs > Date.parse(emitter.closesAt);
    if (caller === undefined || emitter === undefined || closed || emitter.cellId !== caller.cellId) {
      metrics.add(METRIC.unregisteredCaller);
      // One line a minute per role, whatever the session name.
      const key = roleFromCallerArn(userArn)?.roleArn ?? 'not-an-assumed-role';
      const last = this.logged.get(key) ?? 0;
      if (nowMs - last >= MINUTE_MS) {
        if (this.logged.size > 1000) {
          this.logged.clear();
        }
        this.logged.set(key, nowMs);
        log.warn('unregistered caller refused', { caller: caller?.roleArn ?? 'not-an-emitter-role' });
      }
      return undefined;
    }
    return { caller, emitter };
  }

  private emitter(caller: EmitterCaller, fresh = false): Promise<EmitterItem | undefined> {
    const key = keys.emitter(caller.accountId, caller.roleName);
    const load = () => getItem<EmitterItem>(this.deps.db, this.deps.config.tableName, key, fresh);
    return this.mayRefresh(key.PK, fresh) ? this.emitters.refresh(key.PK, load) : this.emitters.get(key.PK, load);
  }

  private binding(cellId: string, tenantId: string, fresh = false): Promise<BindingItem | undefined> {
    const key = keys.binding(cellId, tenantId);
    const load = () => getItem<BindingItem>(this.deps.db, this.deps.config.tableName, key, fresh);
    const cacheKey = `${key.PK}|${key.SK}`;
    return this.mayRefresh(cacheKey, fresh) ? this.bindings.refresh(cacheKey, load) : this.bindings.get(cacheKey, load);
  }

  private mayRefresh(key: string, fresh: boolean): boolean {
    const nowMs = this.now();
    if (!fresh || nowMs - (this.freshAt.get(key) ?? 0) < FRESH_READ_MS) {
      return false;
    }
    if (this.freshAt.size > 10_000) {
      this.freshAt.clear();
    }
    this.freshAt.set(key, nowMs);
    return true;
  }

  private meterVersions(meterId: string): Promise<MeterVersionItem[]> {
    return this.meters.get(meterId, () => meterVersions(this.deps.db, this.deps.config.tableName, meterId));
  }

  /** Adds `count` to a per-emitter counter and returns how many of them fit under `limit`. */
  private async takeFromCounter(key: { PK: string; SK: string }, count: number, limit: number, ttlMs: number): Promise<number> {
    if (count === 0) {
      return 0;
    }
    const out = await withRetry(() =>
      this.deps.db.send(
        new UpdateCommand({
          TableName: this.deps.config.tableName,
          Key: key,
          UpdateExpression: 'ADD #c :n SET expiresAt = if_not_exists(expiresAt, :ttl)',
          ExpressionAttributeNames: { '#c': 'count' },
          ExpressionAttributeValues: { ':n': count, ':ttl': epochSeconds(this.now() + ttlMs) },
          ReturnValues: 'UPDATED_NEW',
        }),
      ),
    );
    const after = Number(out.Attributes?.count ?? count);
    const before = after - count;
    return Math.max(0, Math.min(count, limit - before));
  }

  /** Checks and stores one batch of an admitted emitter (spec §5). */
  async putEvents(admitted: AdmittedEmitter, events: ReadonlyArray<unknown>, requestId: string, metrics: Metrics): Promise<EventOutcome[]> {
    const { config } = this.deps;
    const { caller, emitter } = admitted;
    const nowMs = this.now();
    const receivedAt = iso(nowMs);
    const outcomes: Array<EventOutcome | undefined> = new Array(events.length).fill(undefined);

    // Per-emitter admission limit, over every event of the batch (spec §3.2).
    const admittedCount = await this.takeFromCounter(
      keys.admission(caller.accountId, caller.roleName, minuteOf(nowMs)),
      events.length,
      config.maxEventsPerEmitterPerMinute,
      2 * MINUTE_MS,
    );
    for (let i = admittedCount; i < events.length; i++) {
      outcomes[i] = { result: 'RETRY' };
    }

    // Load what the checks read, then run the pure checks.
    const checked = events.slice(0, admittedCount);
    const tenants = new Set<string>();
    const meterIds = new Set<string>();
    for (const event of checked) {
      if (shapeIsValid(event)) {
        tenants.add(event.tenantId);
        meterIds.add(event.meterId);
      }
    }
    const bindingByTenant = new Map<string, BindingItem | undefined>();
    const versionsByMeter = new Map<string, MeterVersionItem[]>();
    await Promise.all([
      ...[...tenants].map(async (tenantId) => bindingByTenant.set(tenantId, await this.binding(caller.cellId, tenantId))),
      ...[...meterIds].map(async (meterId) => versionsByMeter.set(meterId, await this.meterVersions(meterId))),
    ]);

    let current = emitter;
    const judge = (event: unknown) =>
      checkEvent(event, {
        nowMs,
        recountWindowHours: config.recountWindowHours,
        applicationId: current.applicationId,
        emitter: current,
        binding: (tenantId) => {
          const binding = bindingByTenant.get(tenantId);
          return binding !== undefined && binding.applicationId === current.applicationId ? binding : undefined;
        },
        meterAt: (meterId, hour) => versionAt(versionsByMeter.get(meterId) ?? [], hour),
      });
    const reasons = checked.map((event) => judge(event));

    // A placement refusal may come from a cached miss or a cached CLOSING
    // item that a hook has just changed: re-read those registrations
    // uncached once, so a fresh (re)activation counts at once.
    const placement = new Set<RefusalReason>(['TENANT_NOT_IN_CELL', 'REGISTRATION_CLOSED']);
    const stale = reasons.flatMap((reason, index) => (reason !== undefined && placement.has(reason) ? [index] : []));
    if (stale.length > 0) {
      current = (await this.emitter(caller, true)) ?? current;
      const refreshed = new Set(stale.map((index) => (checked[index] as UsageEvent).tenantId));
      await Promise.all(
        [...refreshed].map(async (tenantId) => bindingByTenant.set(tenantId, await this.binding(caller.cellId, tenantId, true))),
      );
      for (const index of stale) {
        reasons[index] = judge(checked[index]);
      }
    }

    const accepted: Array<{ index: number; event: EnrichedUsageEvent }> = [];
    const refused: Array<{ index: number; reason: RefusalReason }> = [];
    checked.forEach((event, index) => {
      const reason = reasons[index];
      if (reason === undefined) {
        const body = event as UsageEvent;
        accepted.push({
          index,
          event: {
            eventId: body.eventId,
            tenantId: body.tenantId,
            meterId: body.meterId,
            value: body.value,
            time: body.time,
            ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
            applicationId: current.applicationId,
            cellId: current.cellId,
            emitterAccountId: caller.accountId,
            emitterRole: caller.roleName,
            receivedAt,
          },
        });
      } else {
        refused.push({ index, reason });
      }
    });

    // Store the refusals: those that could still count always, the others up to the cap.
    const readmittable = refused.filter((item) => READMITTABLE.has(item.reason));
    const final = refused.filter((item) => !READMITTABLE.has(item.reason));
    const storable = await this.takeFromCounter(
      keys.refusals(caller.accountId, caller.roleName, hourOf(new Date(nowMs))),
      final.length,
      config.maxRefusedPerEmitterPerHour,
      2 * HOUR_MS,
    );
    metrics.add(METRIC.droppedRefusals, final.length - storable);
    const stored = [...readmittable, ...final.slice(0, storable)].sort((a, b) => a.index - b.index);
    let errorObjectWritten = true;
    if (stored.length > 0) {
      const body: ErrorObject = {
        caller: { accountId: caller.accountId, roleName: caller.roleName, cellId: emitter.cellId, applicationId: emitter.applicationId },
        receivedAt,
        requestId,
        events: stored.map((item) => ({ index: item.index, reason: item.reason, event: checked[item.index] })),
      };
      try {
        await this.deps.writeErrorObject(errorObjectKey(nowMs, requestId), JSON.stringify(body));
      } catch (error) {
        errorObjectWritten = false;
        log.error('error object not written', { errorType: error instanceof Error ? error.name : 'unknown', requestId });
      }
    }
    for (const item of refused) {
      // A refusal that could still count is promised to the error store; if
      // that write failed, the emitter resends it (spec P-8).
      outcomes[item.index] =
        READMITTABLE.has(item.reason) && !errorObjectWritten ? { result: 'RETRY' } : { result: 'REFUSED', reason: item.reason };
      metrics.add(METRIC.refused, 1, { reason: item.reason });
    }

    // Store the accepted events.
    const storedIndexes = accepted.length > 0 ? await this.deps.publish(accepted.map((item) => item.event)) : new Set<number>();
    accepted.forEach((item, i) => {
      outcomes[item.index] = storedIndexes.has(i) ? { result: 'ACCEPTED' } : { result: 'RETRY' };
    });

    const final_ = outcomes.map((outcome) => outcome ?? { result: 'RETRY' as const });
    const acceptedCount = final_.filter((outcome) => outcome.result === 'ACCEPTED').length;
    const retryCount = final_.filter((outcome) => outcome.result === 'RETRY').length;
    metrics.add(METRIC.accepted, acceptedCount);
    metrics.add(METRIC.retried, retryCount);
    log.info('batch handled', {
      requestId,
      cellId: emitter.cellId,
      applicationId: emitter.applicationId,
      count: events.length,
      accepted: acceptedCount,
      refused: refused.length,
      retry: retryCount,
    });
    return final_;
  }
}
