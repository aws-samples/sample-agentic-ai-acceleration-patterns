// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sink dispatcher (spec §4.7): one queued delivery is one record for
 * one sink. It reads the record and the sink as they are now (a sink change
 * takes effect at the next dispatch), sends, and records the sink's state
 * on the record without touching `publishPending`, so its own writes never
 * trigger the publisher.
 *
 * - `S3_EXPORT`: one JSON line per record revision in the export bucket.
 * - `HTTP`: a POST of the mapped record with `Idempotency-Key: <recordId>`,
 *   carrying the sink's secret (`auth: SECRET`) or signed with SigV4 as the
 *   dispatcher's role (`auth: AWS_IAM`).
 *   No redirects are followed. A 2xx is `SENT`; a 3xx, or a 4xx other than
 *   408 and 429, is `FAILED` at once; anything else is retried with backoff until
 *   24 hours after the delivery was first queued, then `FAILED`.
 * - An `HTTP` mapping that needs `billingAccount` on a record without one
 *   follows the table of spec §4.7.
 */

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { usageRecordedDetail } from '../publisher/publisher';
import { TtlCache } from '../shared/cache';
import { getItem, tenantBindings } from '../shared/db';
import { billingBinding, type DeliveryMessage, type DeliveryState, type MeterVersionItem, type SinkItem, type UsageRecordItem } from '../shared/items';
import { keys, publishShard } from '../shared/keys';
import { log } from '../shared/logger';
import { METRIC, type Metrics } from '../shared/metrics';
import { isConditionFailure, withRetry } from '../shared/retry';
import { iamSinkTarget, type IamTarget } from '../shared/sink-auth';
import { HOUR_MS, iso } from '../shared/time';

export const DELIVERY_WINDOW_MS = 24 * HOUR_MS;
const HTTP_TIMEOUT_MS = 10_000;

export type DispatchResult = { done: true } | { done: false; retryInSeconds: number };

export interface HttpResponseLike {
  readonly status: number;
}

export type HttpSend = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<HttpResponseLike>;

/** Returns the headers of a SigV4-signed request (an `AWS_IAM` sink). */
export type RequestSigner = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
  target: IamTarget,
) => Promise<Record<string, string>>;

export interface DispatcherDeps {
  readonly db: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly exportBucket: string;
  readonly s3: S3Client;
  readonly secrets: SecretsManagerClient;
  readonly send: HttpSend;
  readonly sign: RequestSigner;
  readonly metrics: Metrics;
  readonly now?: () => number;
}

/** The body an HTTP sink receives: the mapped fields, or the whole `UsageRecorded` detail without a mapping. */
export function mappedBody(sink: Pick<SinkItem, 'mapping'>, record: UsageRecordItem, meter: Pick<MeterVersionItem, 'meterId' | 'version' | 'unit' | 'rule'> | undefined): Record<string, unknown> {
  if (sink.mapping === undefined) {
    return usageRecordedDetail(record);
  }
  const out: Record<string, unknown> = {};
  const recordFields = record as unknown as Record<string, unknown>;
  const meterFields = (meter ?? {}) as Record<string, unknown>;
  for (const [target, source] of Object.entries(sink.mapping)) {
    if ('recordField' in source) {
      out[target] = recordFields[source.recordField];
    } else if ('meterField' in source) {
      out[target] = meterFields[source.meterField];
    } else {
      out[target] = source.constant;
    }
  }
  return out;
}

export function needsBillingAccount(sink: Pick<SinkItem, 'type' | 'mapping'>): boolean {
  return sink.type === 'HTTP' && Object.values(sink.mapping ?? {}).some((source) => 'recordField' in source && source.recordField === 'billingAccount');
}

/**
 * Why a stored `HTTP` sink can never deliver, or undefined: an `AWS_IAM`
 * endpoint that is not a function URL or API Gateway host, or a `SECRET`
 * sink that names no secret.
 */
export function malformedSinkReason(sink: Pick<SinkItem, 'type' | 'auth' | 'endpoint' | 'secretName'>): string | undefined {
  if (sink.type !== 'HTTP') {
    return undefined;
  }
  if (sink.auth === 'AWS_IAM') {
    return iamSinkTarget(sink.endpoint) === undefined ? 'AUTH_TARGET_INVALID' : undefined;
  }
  return sink.secretName === undefined || sink.secretName.length === 0 ? 'SECRET_NAME_MISSING' : undefined;
}

/** Backoff of a retried delivery: 30 s doubling per receive, at most 15 minutes. */
export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, receiveCount - 1));
}

/** The secret as a header: `{"header": ..., "value": ...}`, or a bare token sent as a bearer token. */
export function authHeader(secret: string): [string, string] {
  try {
    const parsed = JSON.parse(secret) as { header?: unknown; value?: unknown };
    if (typeof parsed.header === 'string' && typeof parsed.value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(parsed.header)) {
      return [parsed.header, parsed.value];
    }
  } catch {
    // not JSON: a bare token
  }
  return ['Authorization', `Bearer ${secret}`];
}

export class Dispatcher {
  private readonly now: () => number;
  private readonly secretCache = new TtlCache<string>(5 * 60_000, 100);

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Writes one sink's state. A delivery that is `SENT` stays `SENT`: a
   * duplicate message (a stream retry plus the sweep, a redrive) whose own
   * attempt fails must not overwrite it.
   */
  private async setState(record: UsageRecordItem, sinkId: string, state: DeliveryState, condition = 'attribute_exists(sinks)'): Promise<boolean> {
    const notSent = state.status === 'SENT' ? '' : ' AND (attribute_not_exists(sinks.#sink) OR sinks.#sink.#st <> :sent)';
    try {
      await withRetry(() =>
        this.deps.db.send(
          new UpdateCommand({
            TableName: this.deps.tableName,
            Key: { PK: record.PK, SK: record.SK },
            UpdateExpression: 'SET sinks.#sink = :state',
            ConditionExpression: `${condition}${notSent}`,
            ExpressionAttributeNames: { '#sink': sinkId, ...(notSent ? { '#st': 'status' } : {}) },
            ExpressionAttributeValues: { ':state': state, ...(notSent ? { ':sent': 'SENT' } : {}) },
          }),
        ),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) {
        return false;
      }
      throw error;
    }
  }

  async dispatch(message: DeliveryMessage, receiveCount: number): Promise<DispatchResult> {
    const { db, tableName, metrics } = this.deps;
    let record = await getItem<UsageRecordItem>(db, tableName, { PK: message.PK, SK: message.SK }, true);
    const state = record?.sinks?.[message.sinkId];
    if (record === undefined || state === undefined || state.status === 'SENT' || state.status === 'FAILED') {
      return { done: true };
    }
    const sink = await getItem<SinkItem>(db, tableName, keys.sink(message.sinkId), true);
    if (sink === undefined || !sink.enabled) {
      if (await this.setState(record, message.sinkId, { status: 'FAILED', reason: sink === undefined ? 'SINK_DELETED' : 'SINK_DISABLED' })) {
        metrics.add(METRIC.deliveryFailed, 1, { sinkId: message.sinkId });
      }
      return { done: true };
    }

    // CreateSink and UpdateSink refuse such a sink, so only a direct table
    // write gets here; it can never succeed, so it fails at once.
    const malformed = malformedSinkReason(sink);
    if (malformed !== undefined) {
      if (await this.setState(record, message.sinkId, { status: 'FAILED', reason: malformed })) {
        metrics.add(METRIC.deliveryFailed, 1, { sinkId: message.sinkId });
      }
      log.warn('delivery failed', { sinkId: sink.sinkId, reason: malformed });
      return { done: true };
    }

    if (needsBillingAccount(sink) && record.billingAccount === undefined) {
      const resolved = await this.resolveBillingAccount(record, message.sinkId);
      if (resolved === undefined) {
        return { done: true };
      }
      record = resolved;
    }

    let status: number;
    try {
      status = await this.send(sink, record);
    } catch (error) {
      status = 0;
      log.warn('delivery attempt failed', { sinkId: sink.sinkId, errorType: error instanceof Error ? error.name : 'unknown' });
    }
    if (status >= 200 && status < 300) {
      await this.setState(record, sink.sinkId, { status: 'SENT' });
      metrics.add(METRIC.deliverySent, 1, { sinkId: sink.sinkId });
      return { done: true };
    }
    // A redirect is not followed, so it can never succeed; nor can a 4xx but 408 and 429.
    const permanent = (status >= 300 && status < 400) || (status >= 400 && status < 500 && status !== 408 && status !== 429);
    if (permanent || this.now() - Date.parse(message.firstQueuedAt) >= DELIVERY_WINDOW_MS) {
      // Counted only when the write took: a duplicate that already delivered keeps SENT.
      if (await this.setState(record, sink.sinkId, { status: 'FAILED', reason: permanent ? `HTTP_${status}` : 'RETRIES_EXHAUSTED' })) {
        metrics.add(METRIC.deliveryFailed, 1, { sinkId: sink.sinkId });
      }
      log.warn('delivery failed', { sinkId: sink.sinkId, httpStatus: status });
      return { done: true };
    }
    if (state.status !== 'RETRYING') {
      await this.setState(record, sink.sinkId, { status: 'RETRYING' });
    }
    return { done: false, retryInSeconds: retryDelaySeconds(receiveCount) };
  }

  /**
   * Spec §4.7, a record without `billingAccount` for a sink that needs one.
   * Returns the record to send with, or `undefined` when the delivery is now
   * `BLOCKED` (a revision-2 publish or a resend job queues it again).
   */
  private async resolveBillingAccount(record: UsageRecordItem, sinkId: string): Promise<UsageRecordItem | undefined> {
    const { db, tableName, metrics } = this.deps;
    const binding = billingBinding(await tenantBindings(db, tableName, record.tenantId, record.applicationId, true));
    if (binding?.billingAccount !== undefined) {
      return (await this.writeRevision2(record, sinkId, binding.billingAccount)) ? undefined : this.reread(record);
    }
    const blocked = await this.setState(record, sinkId, { status: 'BLOCKED', reason: 'NO_BILLING_ACCOUNT' }, 'attribute_exists(sinks) AND attribute_not_exists(billingAccount)');
    if (!blocked) {
      return this.reread(record);
    }
    metrics.add(METRIC.deliveryBlocked, 1, { sinkId });
    const again = billingBinding(await tenantBindings(db, tableName, record.tenantId, record.applicationId, true));
    if (again?.billingAccount !== undefined) {
      await this.writeRevision2(record, sinkId, again.billingAccount);
    }
    return undefined;
  }

  /** The "has an account" write: revision 2 with a new marker; its publish queues every `BLOCKED` sink. */
  private async writeRevision2(record: UsageRecordItem, sinkId: string, billingAccount: string): Promise<boolean> {
    try {
      await withRetry(() =>
        this.deps.db.send(
          new UpdateCommand({
            TableName: this.deps.tableName,
            Key: { PK: record.PK, SK: record.SK },
            UpdateExpression: 'SET billingAccount = :ba, revision = :two, publishPending = :marker, publishShard = :shard, sinks.#sink = :blocked',
            ConditionExpression: 'revision = :one',
            ExpressionAttributeNames: { '#sink': sinkId },
            ExpressionAttributeValues: {
              ':ba': billingAccount,
              ':two': 2,
              ':one': 1,
              ':marker': iso(this.now()),
              ':shard': publishShard(record.recordId),
              ':blocked': { status: 'BLOCKED', reason: 'AWAITING_REVISION' },
            },
          }),
        ),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) {
        return false;
      }
      throw error;
    }
  }

  private async reread(record: UsageRecordItem): Promise<UsageRecordItem | undefined> {
    const fresh = await getItem<UsageRecordItem>(this.deps.db, this.deps.tableName, { PK: record.PK, SK: record.SK }, true);
    return fresh?.billingAccount !== undefined ? fresh : undefined;
  }

  private async secret(name: string): Promise<string> {
    return this.secretCache.get(name, async () => {
      const out = await this.deps.secrets.send(new GetSecretValueCommand({ SecretId: name }));
      if (out.SecretString === undefined) {
        throw new Error('the sink secret has no string value');
      }
      return out.SecretString;
    });
  }

  /** Sends one record; resolves to an HTTP status (200 for a stored export). */
  private async send(sink: SinkItem, record: UsageRecordItem): Promise<number> {
    if (sink.type === 'S3_EXPORT') {
      await this.deps.s3.send(
        new PutObjectCommand({
          Bucket: this.deps.exportBucket,
          Key: `${sink.endpoint}hour=${record.hour}/${record.recordId}-r${record.revision}.jsonl`,
          Body: `${JSON.stringify(usageRecordedDetail(record))}\n`,
          ContentType: 'application/x-ndjson',
        }),
      );
      return 200;
    }
    const meter = sink.mapping !== undefined && Object.values(sink.mapping).some((source) => 'meterField' in source)
      ? await getItem<MeterVersionItem>(this.deps.db, this.deps.tableName, keys.meterVersion(record.meterId, record.meterVersion))
      : undefined;
    const init = {
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': record.recordId } as Record<string, string>,
      body: JSON.stringify(mappedBody(sink, record, meter)),
    };
    if (sink.auth === 'AWS_IAM') {
      // dispatch() already failed an invalid target; kept so send() never signs one.
      const target = iamSinkTarget(sink.endpoint);
      if (target === undefined) {
        throw new Error('the AWS_IAM sink endpoint is not a function URL or API Gateway host');
      }
      const response = await this.deps.send(sink.endpoint, { ...init, headers: await this.deps.sign(sink.endpoint, init, target) });
      return response.status;
    }
    if (sink.secretName === undefined || sink.secretName.length === 0) {
      // dispatch() already failed such a sink; kept so send() never reads an unnamed secret.
      throw new Error('the SECRET sink names no secret');
    }
    const [header, value] = authHeader(await this.secret(sink.secretName));
    const response = await this.deps.send(sink.endpoint, { ...init, headers: { ...init.headers, [header]: value } });
    return response.status;
  }
}

/** The HTTP client: no redirects, a 10-second timeout. */
export const fetchSend: HttpSend = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  await response.body?.cancel();
  return { status: response.status };
};
