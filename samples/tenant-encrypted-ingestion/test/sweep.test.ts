// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sweep (spec §8 "Sweep", M-11, M-18): EXPIRED only past TTL plus grace
 * AND with no drop, abandoned leases only past the bound, owed events,
 * REVOKED re-probe, and the conditional inFlight reconcile.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { BUCKET, DELIVERY_ID, KEY_ARN_A, mockSts, NOW, TABLE, tenantClients } from './runtime-helpers';
import { KEY_STATUS_INDEX_NAME, OPEN_INDEX_NAME } from '../src/shared/constants';
import { createSweep, leaseAbandoned, pastExpiry, type SweepConfig } from '../src/sweep/handler';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const events = mockClient(EventBridgeClient);
mockSts();

const CONFIG: SweepConfig = {
  tableName: TABLE,
  bucketName: BUCKET,
  eventBusName: 'delivery-bus',
  maxReceiveCount: 3,
  visibilityTimeoutSeconds: 900,
  abandonGraceSeconds: 3600,
};

const BASE_ROW = {
  PK: 'TENANT#tenant-a',
  SK: `DELIVERY#${DELIVERY_ID}`,
  objectKey: `ingest/tenant-a/${DELIVERY_ID}`,
  fileName: 'case-4711.pdf',
  declaredContentType: 'application/pdf',
  declaredSizeBytes: 812,
  createdBy: 'user-a1',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};
const KEY_ROW = { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'tenant-key', keyArn: KEY_ARN_A, keyStatus: 'ACTIVE', inFlight: 1, updatedAt: '2026-11-05T09:00:00.000Z' };

function sweep() {
  return createSweep({
    config: CONFIG,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    events: new EventBridgeClient({ region: 'eu-central-1' }),
    tenant: tenantClients(),
    now: () => NOW,
  });
}

/** Index contents: `open`, `owed`, and key rows by status. */
function index(contents: { open?: object[]; owed?: object[]; ACTIVE?: object[]; REVOKED?: object[] }) {
  ddb.on(QueryCommand).callsFake((input: { IndexName: string; ExpressionAttributeValues: { ':v': string } }) => {
    const v = input.ExpressionAttributeValues[':v'];
    if (input.IndexName === OPEN_INDEX_NAME) {
      return { Items: v === 'OPEN' ? (contents.open ?? []) : (contents.owed ?? []) };
    }
    if (input.IndexName === KEY_STATUS_INDEX_NAME) {
      return { Items: (contents as Record<string, object[] | undefined>)[v] ?? [] };
    }
    return { Items: [] };
  });
}

beforeEach(() => {
  ddb.reset();
  s3.reset();
  events.reset();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  events.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
  s3.on(DeleteObjectCommand).resolves({});
});

describe('timing predicates', () => {
  it('expiry needs now past urlExpiresAt plus the grace', () => {
    const urlExpiresAt = Math.floor(NOW / 1000) - 3600;
    expect(pastExpiry({ urlExpiresAt }, NOW, 3600)).toBe(false);
    expect(pastExpiry({ urlExpiresAt: urlExpiresAt - 1 }, NOW, 3600)).toBe(true);
  });

  it('a lease is abandoned only after maxReceiveCount x visibility + grace', () => {
    const bound = (3 * 900 + 3600) * 1000;
    expect(leaseAbandoned({ leaseUntil: NOW - bound }, NOW, CONFIG)).toBe(false);
    expect(leaseAbandoned({ leaseUntil: NOW - bound - 1 }, NOW, CONFIG)).toBe(true);
  });
});

describe('EXPIRED (spec §8)', () => {
  const expiredRow = { ...BASE_ROW, status: 'AWAITING_UPLOAD', statusBucket: 'OPEN', urlExpiresAt: Math.floor(NOW / 1000) - 3601 };

  it('expires a row past TTL plus grace whose drop is absent, decrementing inFlight', async () => {
    index({ open: [expiredRow] });
    ddb.on(GetCommand).resolves({ Item: expiredRow });
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    const report = await sweep()();
    expect(report.expired).toBe(1);
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Update!.ExpressionAttributeValues![':set_status']).toBe('EXPIRED');
    expect(items[0].Update!.ConditionExpression).toBe('#status = :awaiting');
    expect(items[0].Update!.UpdateExpression).toContain('REMOVE #statusBucket');
    expect(items[1].Update!.ExpressionAttributeValues![':add_inFlight']).toBe(-1);
    expect(events.calls()).toHaveLength(0);
  });

  it('reads a 403 on the HEAD as absent (the process role cannot list)', async () => {
    index({ open: [expiredRow] });
    ddb.on(GetCommand).resolves({ Item: expiredRow });
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('ad'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    expect((await sweep()()).expired).toBe(1);
  });

  it('never expires while the grace runs, without even a HEAD', async () => {
    const inGrace = { ...expiredRow, urlExpiresAt: Math.floor(NOW / 1000) - 60 };
    index({ open: [inGrace] });
    ddb.on(GetCommand).resolves({ Item: inGrace });
    const report = await sweep()();
    expect(report.expired).toBe(0);
    expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('never expires a row whose upload landed (a long PUT that started in time)', async () => {
    index({ open: [expiredRow] });
    ddb.on(GetCommand).resolves({ Item: expiredRow });
    s3.on(HeadObjectCommand).resolves({ ETag: '"e"' });
    const report = await sweep()();
    expect(report.expired).toBe(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('abandoned leases', () => {
  it('rejects PROCESSING_ABANDONED, deletes the drop version and publishes', async () => {
    const row = { ...BASE_ROW, status: 'PROCESSING', statusBucket: 'OPEN', urlExpiresAt: 1, leaseUntil: NOW - 10 * 3600 * 1000, dropVersionId: 'v1' };
    index({ open: [row] });
    ddb.on(GetCommand).resolves({ Item: row });
    const report = await sweep()();
    expect(report.abandoned).toBe(1);
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Update!.ExpressionAttributeValues![':set_reason']).toBe('structural:PROCESSING_ABANDONED');
    expect(items[0].Update!.ExpressionAttributeValues![':read']).toBe(row.leaseUntil);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input.VersionId).toBe('v1');
    expect(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].DetailType).toBe('DeliveryRejected');
  });
});

describe('owed events', () => {
  it('publishes a terminal row whose event is owed and last touched over 5 minutes ago', async () => {
    const row = { ...BASE_ROW, status: 'ACCEPTED', statusBucket: 'OWED', urlExpiresAt: 1, landedKey: `documents/tenant-a/${DELIVERY_ID}` };
    index({ owed: [row] });
    ddb.on(GetCommand).resolves({ Item: row });
    const report = await sweep()();
    expect(report.republished).toBe(1);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toContain('REMOVE #statusBucket');
    expect(update.ConditionExpression).toContain('attribute_not_exists(#eventPublishedAt)');
  });
});

describe('REVOKED re-probe and inFlight reconcile', () => {
  it('restores ACTIVE only when the probe succeeds', async () => {
    index({ REVOKED: [{ ...KEY_ROW, keyStatus: 'REVOKED', inFlight: 0 }] });
    s3.on(PutObjectCommand).resolves({ VersionId: 'p' });
    s3.on(GetObjectCommand).callsFake(() => ({ Body: { transformToString: async () => 'x' } as never }));
    const report = await sweep()();
    expect(report.restored).toBe(1);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues![':set_keyStatus']).toBe('ACTIVE');
    expect(update.ConditionExpression).toBe('#keyStatus = :revoked');
  });

  it('keeps REVOKED when the probe fails in KMS', async () => {
    index({ REVOKED: [{ ...KEY_ROW, keyStatus: 'REVOKED', inFlight: 0 }] });
    s3.on(PutObjectCommand).rejects(Object.assign(new Error('The key is disabled'), { name: 'KMS.DisabledException' }));
    const report = await sweep()();
    expect(report.restored).toBe(0);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':set_keyStatus']).toBe('REVOKED');
  });

  it('reconciles inFlight to the open-row count, conditional on the value read', async () => {
    index({ ACTIVE: [{ ...KEY_ROW, inFlight: 4 }] });
    const report = await sweep()();
    expect(report.reconciled).toBe(1);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ConditionExpression).toBe('#inFlight = :read');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':read': 4, ':set_inFlight': 0 });
  });

  it('retries the reconcile on conflict with the value read again', async () => {
    index({ ACTIVE: [{ ...KEY_ROW, inFlight: 4 }] });
    ddb.on(UpdateCommand).rejectsOnce(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' })).resolves({});
    ddb.on(GetCommand).resolves({ Item: { ...KEY_ROW, inFlight: 3 } });
    await sweep()();
    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues![':read']);
    expect(updates).toEqual([4, 3]);
  });

  it('leaves a key row touched in the last five minutes alone', async () => {
    index({ ACTIVE: [{ ...KEY_ROW, inFlight: 4, updatedAt: new Date(NOW - 60_000).toISOString() }] });
    expect((await sweep()()).reconciled).toBe(0);
  });
});
