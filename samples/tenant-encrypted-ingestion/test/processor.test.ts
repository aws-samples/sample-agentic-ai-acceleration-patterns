// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The processor (spec §8; M-9, M-10, M-15, M-18, M-20, M-21): step order
 * and pins on the happy path, lease re-entry, terminal re-entry, the
 * step-0 refusals, OBJECT_CHANGED, the last-receive VALIDATOR_ERROR, and the
 * probe classifier both ways.
 */

import { Readable } from 'node:stream';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { BUCKET, captureStdout, DELIVERY_ID, KEY_ARN_A, mockSts, NOW, TABLE, tenantClients } from './runtime-helpers';
import { createProcessor, type ProcessorConfig } from '../src/processor/handler';
import { attributeNames, PROCESS_ROLE_ATTRIBUTES, PROCESSOR_KEY_ROW_ATTRIBUTES } from '../src/shared/registry';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const events = mockClient(EventBridgeClient);
const lambda = mockClient(LambdaClient);
mockSts();

const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF\n');
const ETAG = '"9b2cf535f27731c974343645a3985328"';
const MESSAGE_ID = 'msg-0001';
const OBJECT_KEY = `ingest/tenant-a/${DELIVERY_ID}`;

const CONFIG: ProcessorConfig = {
  tableName: TABLE,
  bucketName: BUCKET,
  eventBusName: 'delivery-bus',
  maxObjectSizeBytes: 1000,
  allowedContentTypes: ['application/pdf', 'application/zip'],
  validators: [{ name: 'test-switch', functionArn: 'arn:aws:lambda:eu-central-1:111122223333:function:test-switch', timeoutSeconds: 30 }],
  validatorObjectUrlTtlSeconds: 300,
  maxReceiveCount: 3,
  processorTimeoutSeconds: 150,
  perTenantMetrics: false,
};

function processor(config: ProcessorConfig = CONFIG) {
  return createProcessor({
    config,
    tenant: tenantClients(),
    baseDdb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    events: new EventBridgeClient({ region: 'eu-central-1' }),
    lambda: new LambdaClient({ region: 'eu-central-1' }),
    now: () => NOW,
  });
}

function sqsEvent(key = OBJECT_KEY, receiveCount = 1, extraDetail: object = {}): SQSEvent {
  return {
    Records: [
      {
        messageId: MESSAGE_ID,
        receiptHandle: 'rh',
        body: JSON.stringify({
          'detail-type': 'Object Created',
          'source': 'aws.s3',
          'detail': { bucket: { name: BUCKET }, object: { 'key': key, 'version-id': 'v-event', 'size': PDF_BYTES.length }, ...extraDetail },
        }),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
          SentTimestamp: '0',
          SenderId: 'events',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:eu-central-1:111122223333:queue',
        awsRegion: 'eu-central-1',
      },
    ],
  };
}

const KEY_ROW = { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'vendor-key', keyArn: KEY_ARN_A, keyStatus: 'ACTIVE', inFlight: 1 };
const AWAITING = {
  PK: 'TENANT#tenant-a',
  SK: `DELIVERY#${DELIVERY_ID}`,
  objectKey: OBJECT_KEY,
  fileName: 'case-4711.pdf',
  declaredContentType: 'application/pdf',
  declaredSizeBytes: PDF_BYTES.length,
  status: 'AWAITING_UPLOAD',
  statusBucket: 'OPEN',
  urlExpiresAt: Math.floor(NOW / 1000) + 600,
  createdBy: 'user-a1',
  createdAt: '2026-11-05T11:59:00.000Z',
  updatedAt: '2026-11-05T11:59:00.000Z',
};

function rows(delivery: object | undefined, key: object | undefined = KEY_ROW) {
  ddb.on(GetCommand).callsFake((input: { Key: { SK: string } }) => ({ Item: input.Key.SK === 'KEY' ? key : delivery }));
}

function headOk(overrides: object = {}) {
  s3.on(HeadObjectCommand).resolves({
    ETag: ETAG,
    VersionId: 'v-drop',
    ContentLength: PDF_BYTES.length,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: KEY_ARN_A,
    BucketKeyEnabled: false,
    ...overrides,
  });
}

function getOk(bytes = PDF_BYTES) {
  s3.on(GetObjectCommand).callsFake(() => ({ Body: Readable.from([bytes]) as never }));
}

const accept = () => lambda.on(InvokeCommand).resolves({ Payload: Buffer.from(JSON.stringify({ version: '1', verdict: 'ACCEPT' })) as never });

function s3Error(name: string, status: number, message = name) {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

/** Every command sent, in order, as a short label. */
function order(): string[] {
  const labels: string[] = [];
  const all = [
    ...ddb.calls().map((c) => ({ c, kind: 'ddb' })),
    ...s3.calls().map((c) => ({ c, kind: 's3' })),
    ...events.calls().map((c) => ({ c, kind: 'events' })),
    ...lambda.calls().map((c) => ({ c, kind: 'lambda' })),
  ];
  all.sort((a, b) => (a.c as unknown as { callId: number }).callId - (b.c as unknown as { callId: number }).callId);
  for (const { c } of all) {
    labels.push((c.args[0] as { constructor: { name: string } }).constructor.name.replace('Command', ''));
  }
  return labels;
}

beforeEach(() => {
  ddb.reset();
  s3.reset();
  events.reset();
  lambda.reset();
  ddb.on(UpdateCommand).resolves({});
  ddb.on(TransactWriteCommand).resolves({});
  events.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e' }] });
  s3.on(DeleteObjectCommand).resolves({});
  s3.on(CopyObjectCommand).resolves({});
});

describe('happy path', () => {
  it('leases, checks, validates, copies, flips, deletes the version read, publishes (in that order)', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    accept();
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([]);
    const seen = order().filter((l) => ['Copy', 'TransactWrite', 'Delete', 'PutEvents'].some((x) => l.startsWith(x)) || l === 'DeleteObject');
    expect(seen).toEqual(['CopyObject', 'TransactWrite', 'DeleteObject', 'PutEvents']);

    const get = s3.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(get.IfMatch).toBe(ETAG);
    const copy = s3.commandCalls(CopyObjectCommand)[0].args[0].input;
    expect(copy).toMatchObject({
      Key: `documents/tenant-a/${DELIVERY_ID}`,
      CopySourceIfMatch: ETAG,
      MetadataDirective: 'REPLACE',
      ContentDisposition: 'attachment; filename="case-4711.pdf"',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KEY_ARN_A,
      BucketKeyEnabled: false,
    });
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({ Key: OBJECT_KEY, VersionId: 'v-drop' });

    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ConditionExpression).toBe('#status = :processing AND #leaseOwner = :me');
    expect(flip[0].Update!.ExpressionAttributeValues![':set_status']).toBe('ACCEPTED');
    expect(flip[1].Update!.ExpressionAttributeValues![':add_inFlight']).toBe(-1);
    // Four plus one per validator (P-9).
    expect(flip[1].Update!.ExpressionAttributeValues![':add_kmsRequests']).toBe(5);

    const detail = JSON.parse(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!);
    expect(detail).toEqual({
      tenantId: 'tenant-a',
      deliveryId: DELIVERY_ID,
      landedKey: `documents/tenant-a/${DELIVERY_ID}`,
      sizeBytes: PDF_BYTES.length,
      contentType: 'application/pdf',
    });
  });

  it('writes only process-role attributes under the tenant session, and the validator gets a pinned GET', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    accept();
    await processor()(sqsEvent());
    for (const call of ddb.commandCalls(UpdateCommand)) {
      for (const name of attributeNames(call.args[0].input)) {
        expect(PROCESS_ROLE_ATTRIBUTES).toContain(name);
      }
    }
    const request = JSON.parse(Buffer.from(lambda.commandCalls(InvokeCommand)[0].args[0].input.Payload as Uint8Array).toString());
    expect(request).toMatchObject({ version: '1', tenantId: 'tenant-a', etag: ETAG, previous: [{ validator: 'structural', verdict: 'ACCEPT' }] });
    const url = new URL(request.objectUrl);
    expect(url.pathname).toBe(`/${OBJECT_KEY}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;if-match');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('logs one line per delivery with tenantId, status and kmsRequests, and never a URL or file name', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    accept();
    const { lines } = await captureStdout(() => processor()(sqsEvent()));
    const processed = lines.filter((l) => l.includes('delivery processed'));
    expect(processed).toHaveLength(1);
    expect(JSON.parse(processed[0])).toMatchObject({ tenantId: 'tenant-a', status: 'ACCEPTED', kmsRequests: 5 });
    expect(lines.join('')).not.toMatch(/X-Amz-Signature|case-4711/);
  });
});

describe('step 0 to 2 (M-15)', () => {
  it('skips a probe object without any call', async () => {
    const result = await processor()(sqsEvent('ingest/tenant-a/_probe/01JBX5Z8Y7W6V5T4S3R2Q1P0NM'));
    expect(result.batchItemFailures).toEqual([]);
    expect(ddb.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });

  it.each(['ingest/TENANT/x', 'ingest/a/b/c', 'documents/tenant-a/x', `ingest/tenant-a/${DELIVERY_ID}/extra`])(
    'deletes the message for key %s with no call and no event',
    async (key) => {
      const result = await processor()(sqsEvent(key));
      expect(result.batchItemFailures).toEqual([]);
      expect(ddb.calls()).toHaveLength(0);
      expect(events.calls()).toHaveLength(0);
    },
  );

  it('takes the tenant from the key, not from event detail or metadata naming another tenant', async () => {
    rows(AWAITING);
    headOk({ Metadata: { tenantid: 'tenant-b' } });
    getOk();
    accept();
    await processor()(sqsEvent(OBJECT_KEY, 1, { tenantId: 'tenant-b' }));
    for (const call of ddb.commandCalls(GetCommand)) {
      expect(call.args[0].input.Key!.PK).toBe('TENANT#tenant-a');
    }
  });

  it('deletes the drop version and stops when the row is missing', async () => {
    rows(undefined);
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([]);
    expect(s3.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({ Key: OBJECT_KEY, VersionId: 'v-event' });
    expect(events.calls()).toHaveLength(0);
  });

  it('deletes the drop version and stops while the key is DELETING', async () => {
    rows(AWAITING, { ...KEY_ROW, keyStatus: 'DELETING' });
    await processor()(sqsEvent());
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });
});

describe('re-entry (M-10)', () => {
  it('re-takes its own lease after a crash after the copy, and lands once', async () => {
    rows({ ...AWAITING, status: 'PROCESSING', leaseOwner: MESSAGE_ID, leaseUntil: NOW + 60_000 });
    headOk();
    getOk();
    accept();
    const result = await processor()(sqsEvent(OBJECT_KEY, 2));
    expect(result.batchItemFailures).toEqual([]);
    const lease = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(lease.ConditionExpression).toContain('#leaseOwner = :me');
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(1);
  });

  it('takes an expired lease of another message', async () => {
    rows({ ...AWAITING, status: 'PROCESSING', leaseOwner: 'msg-other', leaseUntil: NOW - 1 });
    headOk();
    getOk();
    accept();
    await processor()(sqsEvent());
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(1);
  });

  it('stops on another live lease without touching S3', async () => {
    rows({ ...AWAITING, status: 'PROCESSING', leaseOwner: 'msg-other', leaseUntil: NOW + 60_000 });
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([]);
    expect(s3.calls()).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('stops when two receives race for the lease and the other wins', async () => {
    rows(AWAITING);
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([]);
    expect(s3.calls()).toHaveLength(0);
  });

  it('on a terminal row after a crash after the flip: deletes the leftover drop and publishes the owed event', async () => {
    rows({ ...AWAITING, status: 'ACCEPTED', landedKey: `documents/tenant-a/${DELIVERY_ID}`, dropVersionId: 'v-drop', sizeBytes: PDF_BYTES.length });
    await processor()(sqsEvent());
    const deleted = s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.VersionId);
    expect(deleted.sort()).toEqual(['v-drop', 'v-event']);
    expect(events.commandCalls(PutEventsCommand)).toHaveLength(1);
    expect(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].DetailType).toBe('DeliveryAccepted');
  });

  it('on a terminal row whose event is published: deletes the replayed upload and publishes nothing (N-6)', async () => {
    rows({ ...AWAITING, status: 'REJECTED', eventPublishedAt: '2026-11-05T12:00:00.000Z' });
    await processor()(sqsEvent());
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(events.calls()).toHaveLength(0);
  });
});

describe('structural rejections (M-9)', () => {
  it.each([
    ['KEY_MISMATCH', { SSEKMSKeyId: 'arn:aws:kms:eu-central-1:111122223333:key/other' }],
    ['KEY_MISMATCH', { BucketKeyEnabled: true }],
    ['STORAGE_CLASS', { StorageClass: 'GLACIER' }],
    ['SIZE_MISMATCH', { ContentLength: 1 }],
    ['TOO_LARGE', { ContentLength: 5000 }],
  ])('rejects %s from HeadObject without reading the object', async (code, head) => {
    rows(AWAITING);
    headOk(head);
    await processor()(sqsEvent());
    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ExpressionAttributeValues![':set_reason']).toBe(`structural:${code}`);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].DetailType).toBe('DeliveryRejected');
  });

  it('rejects TYPE_MISMATCH for a declared PDF that is a ZIP', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(PDF_BYTES.length - 4)]);
    rows(AWAITING);
    headOk();
    getOk(zip);
    await processor()(sqsEvent());
    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ExpressionAttributeValues![':set_reason']).toBe('structural:TYPE_MISMATCH');
    expect(lambda.calls()).toHaveLength(0);
  });

  it('rejects OBJECT_CHANGED when the ETag pin of the read misses', async () => {
    rows(AWAITING);
    headOk();
    s3.on(GetObjectCommand).rejects(s3Error('PreconditionFailed', 412));
    await processor()(sqsEvent());
    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ExpressionAttributeValues![':set_reason']).toBe('structural:OBJECT_CHANGED');
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });

  it('rejects OBJECT_CHANGED when the copy pin misses', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    accept();
    s3.on(CopyObjectCommand).rejects(s3Error('PreconditionFailed', 412));
    await processor()(sqsEvent());
    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ExpressionAttributeValues![':set_reason']).toBe('structural:OBJECT_CHANGED');
  });
});

describe('validators (M-21)', () => {
  it('rejects <name>:<code> on a REJECT verdict and stores its message', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    lambda.on(InvokeCommand).resolves({
      Payload: Buffer.from(JSON.stringify({ version: '1', verdict: 'REJECT', code: 'TOO_MANY_PAGES', message: '5 pages, limit 3' })) as never,
    });
    await processor()(sqsEvent());
    const values = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Update!.ExpressionAttributeValues!;
    expect(values[':set_reason']).toBe('test-switch:TOO_MANY_PAGES');
    expect(values[':set_reasonMessage']).toBe('5 pages, limit 3');
  });

  it('throws a validator error before the last receive, rejecting nothing', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    lambda.on(InvokeCommand).resolves({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"secret detail"}') as never });
    const { result, lines } = await captureStdout(() => processor()(sqsEvent(OBJECT_KEY, 1)));
    expect(result?.batchItemFailures).toEqual([{ itemIdentifier: MESSAGE_ID }]);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(events.calls()).toHaveLength(0);
    expect(lines.join('')).not.toContain('secret detail');
  });

  it('on the last receive rejects <name>:VALIDATOR_ERROR, deletes the drop, publishes, then throws to the DLQ', async () => {
    rows(AWAITING);
    headOk();
    getOk();
    lambda.on(InvokeCommand).resolves({ Payload: Buffer.from('{"version":"1","verdict":"MAYBE"}') as never });
    const result = await processor()(sqsEvent(OBJECT_KEY, 3));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: MESSAGE_ID }]);
    const values = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Update!.ExpressionAttributeValues!;
    expect(values[':set_reason']).toBe('test-switch:VALIDATOR_ERROR');
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].DetailType).toBe('DeliveryRejected');
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });
});

describe('the probe classifier (M-18)', () => {
  it('marks KEY_UNAVAILABLE and REVOKED when the probe fails in KMS, without a retry', async () => {
    rows(AWAITING);
    s3.on(HeadObjectCommand).rejects(s3Error('AccessDenied', 403));
    s3.on(PutObjectCommand).rejects(s3Error('KMS.DisabledException', 400, 'The key is disabled'));
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([]);
    const flip = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(flip[0].Update!.ExpressionAttributeValues![':set_status']).toBe('KEY_UNAVAILABLE');
    expect(flip[0].Update!.ExpressionAttributeValues![':set_reason']).toBe('KMS.DisabledException');
    const revoke = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.Key!.SK === 'KEY');
    expect(revoke?.ExpressionAttributeValues![':set_keyStatus']).toBe('REVOKED');
    for (const name of attributeNames(revoke!)) {
      expect(PROCESSOR_KEY_ROW_ATTRIBUTES).toContain(name);
    }
    expect(events.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].DetailType).toBe('DeliveryKeyUnavailable');
    // The probe object is under ingest/<t>/_probe/ with the registry key.
    const probe = s3.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(probe.Key).toMatch(/^ingest\/tenant-a\/_probe\/[0-9A-Z]{26}$/);
    expect(probe).toMatchObject({ SSEKMSKeyId: KEY_ARN_A, BucketKeyEnabled: false, IfNoneMatch: '*' });
  });

  it('throws and never marks REVOKED when an S3 403 meets a succeeding probe (the pipeline is at fault)', async () => {
    rows(AWAITING);
    s3.on(HeadObjectCommand).rejects(s3Error('AccessDenied', 403));
    s3.on(PutObjectCommand).resolves({ VersionId: 'probe-v' });
    s3.on(GetObjectCommand).callsFake(() => ({ Body: { transformToString: async () => 'probe' } as never }));
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: MESSAGE_ID }]);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand).filter((c) => c.args[0].input.Key!.SK === 'KEY')).toHaveLength(0);
    expect(events.calls()).toHaveLength(0);
    // The probe cleaned up after itself.
    expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.VersionId)).toContain('probe-v');
  });

  it('throws and never marks REVOKED when the probe fails for a non-KMS reason', async () => {
    rows(AWAITING);
    s3.on(HeadObjectCommand).rejects(s3Error('AccessDenied', 403));
    s3.on(PutObjectCommand).rejects(s3Error('AccessDenied', 403, 'Access Denied'));
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: MESSAGE_ID }]);
    expect(ddb.commandCalls(UpdateCommand).filter((c) => c.args[0].input.Key!.SK === 'KEY')).toHaveLength(0);
  });

  it('rethrows any other error without probing', async () => {
    rows(AWAITING);
    s3.on(HeadObjectCommand).rejects(s3Error('InternalError', 500));
    const result = await processor()(sqsEvent());
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: MESSAGE_ID }]);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});
