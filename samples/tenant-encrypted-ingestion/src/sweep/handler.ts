// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The hourly sweep (spec §8 "Sweep", §6.2; M-11, M-15, M-18). Runs under
 * `sweepRole`, which reads the registry's two GSIs and single rows and may
 * update rows (never `keyArn` or `tier`); every S3 call and every write to
 * a delivery row runs under a `tenantProcessRole` session for the row's
 * tenant, the tenant taken from the row's partition key.
 *
 * 1. `AWAITING_UPLOAD` -> `EXPIRED` (`ttl`, `inFlight - 1`) only when
 *    `now > urlExpiresAt + abandonGraceSeconds` AND `HeadObject` on the drop
 *    is 404, so a long PUT that started in time is never discarded.
 * 2. `PROCESSING` whose `leaseUntil` is older than
 *    `maxReceiveCount x visibility + abandonGraceSeconds` -> `REJECTED
 *    structural:PROCESSING_ABANDONED`, drop version deleted, event published.
 * 3. Terminal rows whose event is still owed (`statusBucket = OWED`, last
 *    touched over `OWED_GRACE_MS` ago, so a processor still finishing is not
 *    raced): the event is published and `eventPublishedAt` set.
 * 4. `REVOKED` key rows: probe through S3; `ACTIVE` only on success.
 * 5. `inFlight` reconciled to the count of the tenant's `OPEN` rows, with an
 *    `UpdateItem` conditional on the value read, retried on conflict. A key
 *    row touched in the last `RECONCILE_QUIET_MS` is left for the next run:
 *    the GSI is eventually consistent, and a delivery created a moment ago
 *    may not be in the count yet.
 *
 * Publishing (3 and 2) needs `events:PutEvents`: spec §7.1 grants it to
 * `sweepRole` and the bus Deny exempts it (ADR-0017,
 * src/construct/events.ts).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ENV, KEY_STATUS_INDEX_NAME, OPEN_INDEX_NAME, requireEnv, requireIntEnv } from '../shared/constants';
import { cancellationCodes, isAccessDenied, isConditionalCheckFailed, isNotFound } from '../shared/errors';
import { eventTypeOf, publishDeliveryEvent } from '../shared/events';
import { errorName, log } from '../shared/logger';
import { probeKeyThroughS3 } from '../shared/probe';
import {
  deliveryOfSk,
  deliveryRowKey,
  type DeliveryRow,
  isoNow,
  type KeyRow,
  keyRowKey,
  PROCESS_ROLE_ATTRIBUTES,
  STATUS_BUCKET,
  tenantOfPk,
  terminalTtl,
  transactUpdate,
  updateInput,
} from '../shared/registry';
import { isTenantId } from '../shared/tenant-id';
import { TenantClients, type TenantCredentials, TenantSessions } from '../shared/tenant-session';

export interface SweepConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly eventBusName: string;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
  readonly abandonGraceSeconds: number;
}

export interface SweepClients {
  readonly ddb: DynamoDBDocumentClient;
  readonly s3: S3Client;
}

export interface SweepDependencies {
  readonly config: SweepConfig;
  /** Under `sweepRole`. */
  readonly ddb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  /** Under a `tenantProcessRole` session for one tenant. */
  readonly tenant: TenantClients<SweepClients>;
  readonly now?: () => number;
}

export const OWED_GRACE_MS = 5 * 60 * 1000;
export const RECONCILE_QUIET_MS = 5 * 60 * 1000;
const SESSION_MIN_MS = 5 * 60 * 1000;

export interface SweepReport {
  expired: number;
  abandoned: number;
  republished: number;
  restored: number;
  reconciled: number;
  errors: number;
}

/**
 * Whether a `HeadObject` error means the drop is not there. `tenantProcessRole`
 * holds `s3:GetObject` on `ingest/${tag}/*` but no `s3:ListBucket` (M-14),
 * and S3 answers a HEAD of a missing key with 403 rather than 404 to a
 * caller that cannot list. A HEAD needs no KMS call, and the role may read
 * every key under its tenant's drop prefix, so under this session a 403 on
 * a drop key means "absent", like the 404.
 */
export function dropAbsent(error: unknown): boolean {
  return isNotFound(error) || isAccessDenied(error);
}

/** Whether an AWAITING_UPLOAD row is past its URL expiry plus the grace (the HeadObject check still follows). */
export function pastExpiry(row: Pick<DeliveryRow, 'urlExpiresAt'>, now: number, graceSeconds: number): boolean {
  return now > (row.urlExpiresAt + graceSeconds) * 1000;
}

/** Whether a PROCESSING row's lease is abandoned (spec §8: maxReceiveCount x visibility + grace). */
export function leaseAbandoned(row: Pick<DeliveryRow, 'leaseUntil'>, now: number, config: SweepConfig): boolean {
  const bound = (config.maxReceiveCount * config.visibilityTimeoutSeconds + config.abandonGraceSeconds) * 1000;
  return (row.leaseUntil ?? 0) + bound < now;
}

export function createSweep(deps: SweepDependencies) {
  const { config } = deps;
  const now = deps.now ?? Date.now;

  async function* queryIndex(index: string, keyName: string, keyValue: string): AsyncGenerator<Record<string, unknown>> {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.ddb.send(
        new QueryCommand({
          TableName: config.tableName,
          IndexName: index,
          KeyConditionExpression: '#k = :v',
          ExpressionAttributeNames: { '#k': keyName },
          ExpressionAttributeValues: { ':v': keyValue },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        yield item;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  async function consistentRow(tenantId: string, deliveryId: string): Promise<DeliveryRow | undefined> {
    return (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: deliveryRowKey(tenantId, deliveryId), ConsistentRead: true })))
      .Item as DeliveryRow | undefined;
  }

  async function expire(tenantId: string, deliveryId: string, row: DeliveryRow, report: SweepReport): Promise<void> {
    const { client } = await deps.tenant.client(tenantId, 'sweep', SESSION_MIN_MS);
    try {
      await client.s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: row.objectKey }));
      return; // an upload is there; the processor owns it
    } catch (error) {
      if (!dropAbsent(error)) {
        throw error;
      }
    }
    const iso = isoNow(now());
    try {
      await client.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            transactUpdate(
              config.tableName,
              deliveryRowKey(tenantId, deliveryId),
              { set: { status: 'EXPIRED', ttl: terminalTtl(now()), updatedAt: iso }, remove: ['statusBucket'], condition: '#status = :awaiting', values: { ':awaiting': 'AWAITING_UPLOAD' } },
              PROCESS_ROLE_ATTRIBUTES,
            ),
            transactUpdate(config.tableName, keyRowKey(tenantId), { add: { inFlight: -1 }, set: { updatedAt: iso }, condition: 'attribute_exists(#PK)' }, PROCESS_ROLE_ATTRIBUTES),
          ],
        }),
      );
      report.expired++;
      log.info('delivery expired', { tenantId, deliveryId, status: 'EXPIRED' });
    } catch (error) {
      if (cancellationCodes(error) === undefined) {
        throw error;
      }
    }
  }

  async function publishOwed(tenantId: string, deliveryId: string, row: DeliveryRow, client: SweepClients): Promise<void> {
    const type = eventTypeOf(row.status);
    if (type !== undefined) {
      await publishDeliveryEvent(deps.events, config.eventBusName, type, {
        tenantId,
        deliveryId,
        landedKey: row.landedKey,
        sizeBytes: row.sizeBytes,
        contentType: row.declaredContentType,
        reason: row.reason,
      });
    }
    try {
      await client.ddb.send(
        new UpdateCommand(
          updateInput(
            config.tableName,
            deliveryRowKey(tenantId, deliveryId),
            {
              set: { eventPublishedAt: isoNow(now()), updatedAt: isoNow(now()) },
              remove: ['statusBucket'],
              condition: 'attribute_exists(#PK) AND attribute_not_exists(#eventPublishedAt)',
            },
            PROCESS_ROLE_ATTRIBUTES,
          ),
        ),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }
  }

  async function abandon(tenantId: string, deliveryId: string, row: DeliveryRow, report: SweepReport): Promise<void> {
    const { client } = await deps.tenant.client(tenantId, 'sweep', SESSION_MIN_MS);
    const iso = isoNow(now());
    const reason = 'structural:PROCESSING_ABANDONED';
    try {
      await client.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            transactUpdate(
              config.tableName,
              deliveryRowKey(tenantId, deliveryId),
              {
                set: { status: 'REJECTED', statusBucket: STATUS_BUCKET.owed, reason, ttl: terminalTtl(now()), updatedAt: iso },
                condition: '#status = :processing AND #leaseUntil = :read',
                values: { ':processing': 'PROCESSING', ':read': row.leaseUntil ?? 0 },
              },
              PROCESS_ROLE_ATTRIBUTES,
            ),
            transactUpdate(
              config.tableName,
              keyRowKey(tenantId),
              { add: { inFlight: -1, deliveriesRejected: 1 }, set: { updatedAt: iso }, condition: 'attribute_exists(#PK)' },
              PROCESS_ROLE_ATTRIBUTES,
            ),
          ],
        }),
      );
    } catch (error) {
      if (cancellationCodes(error) !== undefined) {
        return;
      }
      throw error;
    }
    let versionId = row.dropVersionId;
    if (versionId === undefined) {
      try {
        versionId = (await client.s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: row.objectKey }))).VersionId;
      } catch (error) {
        if (!dropAbsent(error)) {
          throw error;
        }
      }
    }
    if (versionId !== undefined) {
      await client.s3.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: row.objectKey, VersionId: versionId }));
    }
    await publishOwed(tenantId, deliveryId, { ...row, status: 'REJECTED', reason }, client);
    report.abandoned++;
    log.info('lease abandoned', { tenantId, deliveryId, status: 'REJECTED', reason });
  }

  async function reconcile(row: KeyRow, open: number, report: SweepReport): Promise<void> {
    const tenantId = tenantOfPk(row.PK)!;
    let current: KeyRow | undefined = row;
    for (let attempt = 0; attempt < 3 && current !== undefined; attempt++) {
      if ((current.inFlight ?? 0) === open || now() - Date.parse(current.updatedAt) < RECONCILE_QUIET_MS) {
        return;
      }
      try {
        await deps.ddb.send(
          new UpdateCommand(
            updateInput(config.tableName, keyRowKey(tenantId), {
              set: { inFlight: open },
              condition: current.inFlight === undefined ? 'attribute_not_exists(#inFlight)' : '#inFlight = :read',
              values: current.inFlight === undefined ? undefined : { ':read': current.inFlight },
            }),
          ),
        );
        report.reconciled++;
        log.info('inFlight reconciled', { tenantId, count: open });
        return;
      } catch (error) {
        if (!isConditionalCheckFailed(error)) {
          throw error;
        }
        current = (await deps.ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true }))).Item as
          | KeyRow
          | undefined;
      }
    }
  }

  return async (): Promise<SweepReport> => {
    const report: SweepReport = { expired: 0, abandoned: 0, republished: 0, restored: 0, reconciled: 0, errors: 0 };
    const at = now();
    const openCounts = new Map<string, number>();

    // 1 and 2: open deliveries.
    for await (const item of queryIndex(OPEN_INDEX_NAME, 'statusBucket', STATUS_BUCKET.open)) {
      const tenantId = tenantOfPk(item.PK);
      const deliveryId = deliveryOfSk(item.SK);
      if (!isTenantId(tenantId) || deliveryId === undefined) {
        continue;
      }
      openCounts.set(tenantId, (openCounts.get(tenantId) ?? 0) + 1);
      try {
        const row = await consistentRow(tenantId, deliveryId);
        if (row === undefined) {
          continue;
        }
        if (row.status === 'AWAITING_UPLOAD' && pastExpiry(row, at, config.abandonGraceSeconds)) {
          await expire(tenantId, deliveryId, row, report);
        } else if (row.status === 'PROCESSING' && leaseAbandoned(row, at, config)) {
          await abandon(tenantId, deliveryId, row, report);
        }
      } catch (error) {
        report.errors++;
        log.error('sweep step failed', { tenantId, deliveryId, step: 'open', errorType: errorName(error) });
      }
    }

    // 3: owed events.
    for await (const item of queryIndex(OPEN_INDEX_NAME, 'statusBucket', STATUS_BUCKET.owed)) {
      const tenantId = tenantOfPk(item.PK);
      const deliveryId = deliveryOfSk(item.SK);
      if (!isTenantId(tenantId) || deliveryId === undefined) {
        continue;
      }
      try {
        const row = await consistentRow(tenantId, deliveryId);
        if (row === undefined || row.eventPublishedAt !== undefined || at - Date.parse(row.updatedAt) < OWED_GRACE_MS) {
          continue;
        }
        const { client } = await deps.tenant.client(tenantId, 'sweep', SESSION_MIN_MS);
        await publishOwed(tenantId, deliveryId, row, client);
        report.republished++;
        log.info('owed event published', { tenantId, deliveryId, status: row.status });
      } catch (error) {
        report.errors++;
        log.error('sweep step failed', { tenantId, deliveryId, step: 'owed', errorType: errorName(error) });
      }
    }

    // 4 and 5: key rows.
    for (const status of ['REVOKED', 'ACTIVE'] as const) {
      for await (const item of queryIndex(KEY_STATUS_INDEX_NAME, 'keyStatus', status)) {
        const row = item as unknown as KeyRow;
        const tenantId = tenantOfPk(row.PK);
        if (!isTenantId(tenantId)) {
          continue;
        }
        try {
          if (status === 'REVOKED') {
            const { client } = await deps.tenant.client(tenantId, 'sweep', SESSION_MIN_MS);
            const probe = await probeKeyThroughS3(client.s3, config.bucketName, tenantId, row.keyArn);
            const iso = isoNow(now());
            try {
              await deps.ddb.send(
                new UpdateCommand(
                  updateInput(config.tableName, keyRowKey(tenantId), {
                    set: { keyStatus: probe.outcome === 'usable' ? 'ACTIVE' : 'REVOKED', lastKeyCheckAt: iso },
                    condition: '#keyStatus = :revoked',
                    values: { ':revoked': 'REVOKED' },
                  }),
                ),
              );
              if (probe.outcome === 'usable') {
                report.restored++;
                log.info('tenant key restored', { tenantId, keyStatus: 'ACTIVE' });
              }
            } catch (error) {
              if (!isConditionalCheckFailed(error)) {
                throw error;
              }
            }
          }
          await reconcile(row, openCounts.get(tenantId) ?? 0, report);
        } catch (error) {
          report.errors++;
          log.error('sweep step failed', { tenantId, step: 'key', errorType: errorName(error) });
        }
      }
    }
    log.info('sweep finished', { operation: 'sweep', count: report.expired + report.abandoned + report.republished + report.restored + report.reconciled });
    return report;
  };
}

let cached: ReturnType<typeof createSweep> | undefined;

export async function handler(): Promise<SweepReport> {
  if (cached === undefined) {
    const region = requireEnv('AWS_REGION');
    const sessions = new TenantSessions(new STSClient({}), requireEnv(ENV.tenantProcessRoleArn));
    cached = createSweep({
      config: {
        tableName: requireEnv(ENV.tableName),
        bucketName: requireEnv(ENV.bucketName),
        eventBusName: requireEnv(ENV.eventBusName),
        maxReceiveCount: requireIntEnv(ENV.maxReceiveCount),
        visibilityTimeoutSeconds: requireIntEnv(ENV.visibilityTimeoutSeconds),
        abandonGraceSeconds: requireIntEnv(ENV.abandonGraceSeconds),
      },
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
      events: new EventBridgeClient({}),
      tenant: new TenantClients<SweepClients>(sessions, (credentials: TenantCredentials) => ({
        ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }), { marshallOptions: { removeUndefinedValues: true } }),
        s3: new S3Client({ region, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
      })),
    });
  }
  return cached();
}
