// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The processor: validate, then land (spec §8, P-10, ADR-0007, ADR-0009;
 * M-9, M-10, M-15, M-18, M-21, M-28). One SQS message per invocation
 * (batch size 1), carrying an EventBridge `Object Created` event for
 * `ingest/`.
 *
 *  0. t, d from the key; t fails §7.0, or the third segment is `_probe`:
 *     delete the message, stop.
 *  1. Assume `tenantProcessRole` {TenantId: t} BEFORE reading anything, so a
 *     wrong id is `AccessDenied`, never another tenant's row.
 *  2. Row and key row, `ConsistentRead`:
 *     - row or key row missing, or `DELETING`: delete the drop version, stop;
 *     - terminal: delete a leftover drop version; publish an owed event; stop;
 *     - `AWAITING_UPLOAD`, or `PROCESSING` with own or expired lease: lease;
 *     - `PROCESSING` with another live lease: stop.
 *  3. `HeadObject`: `dropEtag`, `dropVersionId`; key, storage class, size.
 *  4. `GetObject` `IfMatch dropEtag`: magic bytes, ZIP directory, sha256.
 *  5. Validators in order; REJECT rejects; an error is thrown, and on the
 *     last receive rejects with `<name>:VALIDATOR_ERROR` and is then thrown
 *     (the DLQ copy is an audit record).
 *  6. `CopyObject` to `documents/<t>/<d>`, bucket key off,
 *     `CopySourceIfMatch dropEtag`, metadata REPLACE.
 *  7. Row ACCEPTED on `leaseOwner`; counters; `inFlight - 1`.
 *  8. `DeleteObject` of exactly `dropVersionId`.
 *  9. `PutEvents`; `SET eventPublishedAt`.
 *
 * A 403 from S3 at steps 3 to 8 runs the probe (src/processor/probe.ts).
 * Copy, flip, delete, publish: a crash after the copy leaves a lease the
 * next receive re-takes (the copy repeats, pinned to the same ETag); a crash
 * after the flip leaves a terminal row, and step 2 removes the drop and
 * publishes the owed event.
 *
 * Every tenant-role write is an `UpdateItem` naming only
 * `PROCESS_ROLE_ATTRIBUTES` (src/shared/registry.ts); the one base-role
 * write sets `REVOKED` on the key row with `PROCESSOR_KEY_ROW_ATTRIBUTES`.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { guardS3, KeyUnavailableError } from './probe';
import { contentProblem, digestStream, headProblem, type StructuralCode, structuralReason } from './structural';
import { parseValidatorBindings, runValidatorChain, type ValidatorBinding } from './validators';
import { boolEnv, ENV, requireEnv, requireIntEnv } from '../shared/constants';
import { cancellationCodes, isConditionalCheckFailed, isPreconditionFailed } from '../shared/errors';
import { type DeliveryEventType, eventTypeOf, publishDeliveryEvent } from '../shared/events';
import { errorName, log } from '../shared/logger';
import { emitDeliveryMetric, KmsMeter } from '../shared/metering';
import { probeKeyThroughS3 } from '../shared/probe';
import {
  deliveryRowKey,
  type DeliveryRow,
  isoNow,
  type KeyRow,
  keyRowKey,
  PROCESS_ROLE_ATTRIBUTES,
  PROCESSOR_KEY_ROW_ATTRIBUTES,
  STATUS_BUCKET,
  terminalTtl,
  TERMINAL_STATUSES,
  transactUpdate,
  updateInput,
  type ValidatorRecord,
} from '../shared/registry';
import { landedKey as landedKeyOf, parseDropKey } from '../shared/tenant-id';
import { TenantClients, type TenantCredentials, TenantSessions } from '../shared/tenant-session';

export interface ProcessorConfig {
  readonly tableName: string;
  readonly bucketName: string;
  readonly eventBusName: string;
  readonly maxObjectSizeBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly validators: readonly ValidatorBinding[];
  readonly validatorObjectUrlTtlSeconds: number;
  readonly maxReceiveCount: number;
  /** T, the processor's own timeout (spec §8 "Timing"). */
  readonly processorTimeoutSeconds: number;
  readonly perTenantMetrics: boolean;
}

export interface ProcessClients {
  readonly ddb: DynamoDBDocumentClient;
  readonly s3: S3Client;
}

export interface ProcessorDependencies {
  readonly config: ProcessorConfig;
  /** Under a `tenantProcessRole` session for one tenant. */
  readonly tenant: TenantClients<ProcessClients>;
  /** Under `processorRole`: sets `REVOKED` only. */
  readonly baseDdb: DynamoDBDocumentClient;
  readonly events: EventBridgeClient;
  readonly lambda: LambdaClient;
  readonly now?: () => number;
}

/** What the processor reads from an `Object Created` event (never the tenant: that is the key). */
export interface DropEvent {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
}

export function parseDropEvent(body: string): DropEvent | undefined {
  try {
    const event = JSON.parse(body) as { detail?: { bucket?: { name?: unknown }; object?: { 'key'?: unknown; 'version-id'?: unknown } } };
    const bucket = event.detail?.bucket?.name;
    const key = event.detail?.object?.key;
    const versionId = event.detail?.object?.['version-id'];
    if (typeof bucket !== 'string' || typeof key !== 'string') {
      return undefined;
    }
    return { bucket, key: decodeURIComponent(key.replace(/\+/g, ' ')), versionId: typeof versionId === 'string' ? versionId : undefined };
  } catch {
    return undefined;
  }
}

/** Thrown to retry a message whose validator failed before its last receive. */
export class ValidatorRetryError extends Error {
  constructor(readonly validator: string) {
    super('validator error; the message is retried');
    this.name = 'ValidatorRetryError';
  }
}

interface Terminal {
  readonly status: 'ACCEPTED' | 'REJECTED' | 'KEY_UNAVAILABLE';
  readonly reason?: string;
  readonly reasonMessage?: string;
  readonly validators?: ValidatorRecord[];
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly dropEtag?: string;
  readonly dropVersionId?: string;
  readonly landedKey?: string;
  readonly kmsRequests: number;
}

export function createProcessor(deps: ProcessorDependencies) {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const T = config.processorTimeoutSeconds * 1000;

  async function deleteVersion(s3: S3Client, key: string, versionId: string | undefined): Promise<void> {
    if (versionId === undefined) {
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key, VersionId: versionId }));
  }

  async function markPublished(ddb: DynamoDBDocumentClient, tenantId: string, deliveryId: string): Promise<void> {
    try {
      await ddb.send(
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

  async function publish(
    ddb: DynamoDBDocumentClient,
    type: DeliveryEventType,
    tenantId: string,
    deliveryId: string,
    row: Pick<DeliveryRow, 'declaredContentType'> & Partial<Pick<DeliveryRow, 'landedKey' | 'sizeBytes' | 'reason'>>,
  ): Promise<void> {
    await publishDeliveryEvent(deps.events, config.eventBusName, type, {
      tenantId,
      deliveryId,
      landedKey: row.landedKey,
      sizeBytes: row.sizeBytes,
      contentType: row.declaredContentType,
      reason: row.reason,
    });
    await markPublished(ddb, tenantId, deliveryId);
  }

  /** Writes a terminal status on the lease, in one transaction with the key row's counters. Returns false when the lease was lost. */
  async function finish(ddb: DynamoDBDocumentClient, tenantId: string, deliveryId: string, leaseOwner: string, terminal: Terminal): Promise<boolean> {
    const iso = isoNow(now());
    const accepted = terminal.status === 'ACCEPTED';
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            transactUpdate(
              config.tableName,
              deliveryRowKey(tenantId, deliveryId),
              {
                set: {
                  status: terminal.status,
                  statusBucket: STATUS_BUCKET.owed,
                  reason: terminal.reason,
                  reasonMessage: terminal.reasonMessage,
                  validators: terminal.validators,
                  sizeBytes: terminal.sizeBytes,
                  sha256: terminal.sha256,
                  dropEtag: terminal.dropEtag,
                  dropVersionId: terminal.dropVersionId,
                  landedKey: terminal.landedKey,
                  ttl: accepted ? undefined : terminalTtl(now()),
                  updatedAt: iso,
                },
                condition: '#status = :processing AND #leaseOwner = :me',
                values: { ':processing': 'PROCESSING', ':me': leaseOwner },
              },
              PROCESS_ROLE_ATTRIBUTES,
            ),
            transactUpdate(
              config.tableName,
              keyRowKey(tenantId),
              {
                add: {
                  inFlight: -1,
                  kmsRequests: terminal.kmsRequests,
                  ...(accepted ? { deliveriesAccepted: 1, bytesStored: terminal.sizeBytes ?? 0 } : { deliveriesRejected: 1 }),
                },
                set: { updatedAt: iso },
                condition: 'attribute_exists(#PK)',
              },
              PROCESS_ROLE_ATTRIBUTES,
            ),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (cancellationCodes(error) !== undefined) {
        return false;
      }
      throw error;
    }
  }

  async function processRecord(record: SQSRecord): Promise<void> {
    const started = now();
    const receiveCount = Number(record.attributes.ApproximateReceiveCount ?? '1');
    const lastReceive = receiveCount >= config.maxReceiveCount;
    const drop = parseDropEvent(record.body);

    // Step 0. The tenant is the key's second segment and nothing else.
    if (drop === undefined || drop.bucket !== config.bucketName) {
      log.warn('message ignored', { step: '0', reason: 'not a drop of this bucket' });
      return;
    }
    const parsed = parseDropKey(drop.key);
    if (parsed.kind === 'probe') {
      return;
    }
    if (parsed.kind === 'invalid') {
      log.warn('message ignored', { step: '0', reason: 'object key fails the grammar' });
      return;
    }
    const { tenantId, deliveryId } = parsed;

    // Step 1. The tenant session, before anything is read.
    const { client } = await deps.tenant.client(tenantId, deliveryId, T);
    const { ddb, s3 } = client;

    // Step 2.
    const [rowItem, keyItem] = await Promise.all([
      ddb.send(new GetCommand({ TableName: config.tableName, Key: deliveryRowKey(tenantId, deliveryId), ConsistentRead: true })),
      ddb.send(new GetCommand({ TableName: config.tableName, Key: keyRowKey(tenantId), ConsistentRead: true })),
    ]);
    const row = rowItem.Item as DeliveryRow | undefined;
    const keyRow = keyItem.Item as KeyRow | undefined;
    if (row === undefined || keyRow === undefined || keyRow.keyStatus === 'DELETING') {
      await deleteVersion(s3, drop.key, drop.versionId);
      log.info('drop without a delivery deleted', { tenantId, deliveryId, step: '2' });
      return;
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      await deleteVersion(s3, drop.key, drop.versionId);
      if (row.dropVersionId !== undefined && row.dropVersionId !== drop.versionId) {
        await deleteVersion(s3, drop.key, row.dropVersionId);
      }
      const type = eventTypeOf(row.status);
      if (type !== undefined && row.eventPublishedAt === undefined) {
        await publish(ddb, type, tenantId, deliveryId, row);
      }
      log.info('terminal delivery re-entered', { tenantId, deliveryId, step: '2', status: row.status });
      return;
    }
    const at = now();
    const ownLease = row.status === 'PROCESSING' && (row.leaseOwner === record.messageId || (row.leaseUntil ?? 0) < at);
    if (row.status !== 'AWAITING_UPLOAD' && !ownLease) {
      log.info('delivery leased elsewhere', { tenantId, deliveryId, step: '2' });
      return;
    }
    try {
      await ddb.send(
        new UpdateCommand(
          updateInput(
            config.tableName,
            deliveryRowKey(tenantId, deliveryId),
            {
              set: { status: 'PROCESSING', leaseOwner: record.messageId, leaseUntil: at + T, updatedAt: isoNow(at) },
              condition: '#status = :awaiting OR (#status = :processing AND (#leaseOwner = :me OR #leaseUntil < :now))',
              values: { ':awaiting': 'AWAITING_UPLOAD', ':processing': 'PROCESSING', ':me': record.messageId, ':now': at },
            },
            PROCESS_ROLE_ATTRIBUTES,
          ),
        ),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        log.info('delivery leased elsewhere', { tenantId, deliveryId, step: '2' });
        return;
      }
      throw error;
    }

    const keyArn = keyRow.keyArn;
    const probe = () => probeKeyThroughS3(s3, config.bucketName, tenantId, keyArn);
    const meter = new KmsMeter();
    let dropEtag: string | undefined;
    let dropVersionId: string | undefined = drop.versionId;

    const done = async (terminal: Terminal): Promise<void> => {
      if (!(await finish(ddb, tenantId, deliveryId, record.messageId, terminal))) {
        log.info('lease lost before the flip', { tenantId, deliveryId });
        return;
      }
      await guardS3(() => deleteVersion(s3, drop.key, terminal.dropVersionId ?? dropVersionId), probe).catch((error: unknown) => {
        if (!(error instanceof KeyUnavailableError)) {
          throw error;
        }
      });
      const type = eventTypeOf(terminal.status)!;
      await publish(ddb, type, tenantId, deliveryId, { ...row, ...terminal });
      emitDeliveryMetric(config.perTenantMetrics, {
        tenantId,
        status: terminal.status,
        sizeBytes: terminal.sizeBytes ?? 0,
        kmsRequests: terminal.kmsRequests,
        durationMs: now() - started,
      });
      log.info('delivery processed', {
        tenantId,
        deliveryId,
        status: terminal.status,
        reason: terminal.reason,
        kmsRequests: terminal.kmsRequests,
        sizeBytes: terminal.sizeBytes,
        durationMs: now() - started,
        receiveCount,
      });
    };
    const reject = (code: string, extra: Partial<Terminal> = {}) =>
      done({ status: 'REJECTED', reason: code, dropEtag, dropVersionId, kmsRequests: meter.total, ...extra });

    try {
      // Step 3.
      const head = await guardS3(() => s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: drop.key })), probe);
      dropEtag = head.ETag;
      dropVersionId = head.VersionId ?? dropVersionId;
      const headCode = headProblem(head, {
        keyArn,
        declaredSizeBytes: row.declaredSizeBytes,
        maxObjectSizeBytes: config.maxObjectSizeBytes,
      });
      if (headCode !== undefined || dropEtag === undefined) {
        await reject(structuralReason(headCode ?? 'OBJECT_CHANGED'), { sizeBytes: head.ContentLength });
        return;
      }
      const etag = dropEtag;

      // Step 4.
      let digest;
      try {
        digest = await guardS3(async () => {
          const got = await s3.send(new GetObjectCommand({ Bucket: config.bucketName, Key: drop.key, IfMatch: etag }));
          meter.read();
          return digestStream(got.Body as AsyncIterable<Uint8Array>);
        }, probe);
      } catch (error) {
        if (isPreconditionFailed(error)) {
          await reject(structuralReason('OBJECT_CHANGED'));
          return;
        }
        throw error;
      }
      const contentCode: StructuralCode | undefined =
        digest.sizeBytes !== row.declaredSizeBytes ? 'SIZE_MISMATCH' : contentProblem(digest, row.declaredContentType, config.allowedContentTypes);
      if (contentCode !== undefined) {
        await reject(structuralReason(contentCode), { sizeBytes: digest.sizeBytes, sha256: digest.sha256 });
        return;
      }

      // Step 5.
      const chain = await runValidatorChain(
        config.validators,
        {
          tenantId,
          deliveryId,
          fileName: row.fileName,
          contentType: row.declaredContentType,
          sizeBytes: digest.sizeBytes,
          sha256: digest.sha256,
          bucket: config.bucketName,
          key: drop.key,
          etag,
        },
        { lambda: deps.lambda, s3, urlTtlSeconds: config.validatorObjectUrlTtlSeconds, now, onRead: () => meter.read() },
      );
      if (chain.outcome === 'rejected') {
        await reject(`${chain.validator}:${chain.code}`, {
          reasonMessage: chain.message,
          validators: chain.records,
          sizeBytes: digest.sizeBytes,
          sha256: digest.sha256,
        });
        return;
      }
      if (chain.outcome === 'error') {
        if (lastReceive) {
          await reject(`${chain.validator}:VALIDATOR_ERROR`, { validators: chain.records, sizeBytes: digest.sizeBytes, sha256: digest.sha256 });
        }
        // Retried, or on the last receive moved to the DLQ as an audit record.
        throw new ValidatorRetryError(chain.validator);
      }

      // Step 6.
      const landed = landedKeyOf(tenantId, deliveryId);
      try {
        await guardS3(
          () =>
            s3.send(
              new CopyObjectCommand({
                Bucket: config.bucketName,
                Key: landed,
                CopySource: `${config.bucketName}/${drop.key}`,
                CopySourceIfMatch: etag,
                MetadataDirective: 'REPLACE',
                ContentType: row.declaredContentType,
                ContentDisposition: `attachment; filename="${row.fileName}"`,
                ServerSideEncryption: 'aws:kms',
                SSEKMSKeyId: keyArn,
                BucketKeyEnabled: false,
              }),
            ),
          probe,
        );
        meter.copy();
      } catch (error) {
        if (isPreconditionFailed(error)) {
          await reject(structuralReason('OBJECT_CHANGED'), { validators: chain.records, sizeBytes: digest.sizeBytes, sha256: digest.sha256 });
          return;
        }
        throw error;
      }

      // Steps 7, 8, 9.
      await done({
        status: 'ACCEPTED',
        landedKey: landed,
        validators: chain.records,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        dropEtag: etag,
        dropVersionId,
        kmsRequests: meter.total,
      });
    } catch (error) {
      if (!(error instanceof KeyUnavailableError)) {
        throw error;
      }
      // Fail closed (P-5): the delivery, the key, the drop, the event; no retry.
      await done({ status: 'KEY_UNAVAILABLE', reason: error.kmsError, dropEtag, dropVersionId, kmsRequests: meter.total });
      const iso = isoNow(now());
      try {
        await deps.baseDdb.send(
          new UpdateCommand(
            updateInput(
              config.tableName,
              keyRowKey(tenantId),
              { set: { keyStatus: 'REVOKED', lastKeyCheckAt: iso, updatedAt: iso }, condition: '#keyStatus = :active', values: { ':active': 'ACTIVE' } },
              PROCESSOR_KEY_ROW_ATTRIBUTES,
            ),
          ),
        );
        log.warn('tenant key revoked', { tenantId, deliveryId, keyStatus: 'REVOKED' });
      } catch (revokeError) {
        if (!isConditionalCheckFailed(revokeError)) {
          throw revokeError;
        }
      }
    }
  }

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        await processRecord(record);
      } catch (error) {
        const drop = parseDropEvent(record.body);
        const parsed = drop === undefined ? undefined : parseDropKey(drop.key);
        log.error('message failed', {
          tenantId: parsed !== undefined && parsed.kind !== 'invalid' ? parsed.tenantId : undefined,
          deliveryId: parsed?.kind === 'delivery' ? parsed.deliveryId : undefined,
          errorType: errorName(error),
          receiveCount: Number(record.attributes.ApproximateReceiveCount ?? '1'),
        });
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

let cached: ReturnType<typeof createProcessor> | undefined;

function fromEnv(): ReturnType<typeof createProcessor> {
  const region = requireEnv('AWS_REGION');
  const sessions = new TenantSessions(new STSClient({}), requireEnv(ENV.tenantProcessRoleArn));
  return createProcessor({
    config: {
      tableName: requireEnv(ENV.tableName),
      bucketName: requireEnv(ENV.bucketName),
      eventBusName: requireEnv(ENV.eventBusName),
      maxObjectSizeBytes: requireIntEnv(ENV.maxObjectSizeBytes),
      allowedContentTypes: requireEnv(ENV.allowedContentTypes).split(','),
      validators: parseValidatorBindings(process.env[ENV.validators]),
      validatorObjectUrlTtlSeconds: requireIntEnv(ENV.validatorObjectUrlTtlSeconds),
      maxReceiveCount: requireIntEnv(ENV.maxReceiveCount),
      processorTimeoutSeconds: requireIntEnv(ENV.processorTimeoutSeconds),
      perTenantMetrics: boolEnv(ENV.perTenantMetrics),
    },
    tenant: new TenantClients<ProcessClients>(sessions, (credentials: TenantCredentials) => ({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }), { marshallOptions: { removeUndefinedValues: true } }),
      s3: new S3Client({ region, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
    })),
    baseDdb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    events: new EventBridgeClient({}),
    lambda: new LambdaClient({}),
  });
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  cached ??= fromEnv();
  return cached(event);
}
