// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry watch (M-24): MODIFY of a binding alarms, REMOVE writes a
 * tombstone, INSERT after a tombstone alarms, nothing is logged from an
 * image.
 */

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { captureStdout, KEY_ARN_A, KEY_ARN_B, NOW, TABLE } from './runtime-helpers';
import { createWatch } from '../src/registry-watch/handler';

const ddb = mockClient(DynamoDBDocumentClient);
const cloudwatch = mockClient(CloudWatchClient);

function watch() {
  return createWatch({
    tableName: TABLE,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    cloudwatch: new CloudWatchClient({ region: 'eu-central-1' }),
    now: () => NOW,
  });
}

function image(keyArn: string, tier = 'vendor-key') {
  return { PK: { S: 'TENANT#tenant-a' }, SK: { S: 'KEY' }, keyArn: { S: keyArn }, tier: { S: tier }, keyStatus: { S: 'ACTIVE' } };
}

function record(eventName: 'INSERT' | 'MODIFY' | 'REMOVE', oldImage?: object, newImage?: object, pk = 'TENANT#tenant-a'): DynamoDBRecord {
  return {
    eventName,
    dynamodb: { Keys: { PK: { S: pk }, SK: { S: 'KEY' } }, OldImage: oldImage as never, NewImage: newImage as never },
  };
}

const event = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

beforeEach(() => {
  ddb.reset();
  cloudwatch.reset();
  ddb.on(UpdateCommand).resolves({});
  cloudwatch.on(PutMetricDataCommand).resolves({});
});

describe('registry watch', () => {
  it('alarms on a MODIFY that changes keyArn, and never logs the image', async () => {
    const { lines } = await captureStdout(() => watch()(event(record('MODIFY', image(KEY_ARN_A), image(KEY_ARN_B)))));
    expect(cloudwatch.commandCalls(PutMetricDataCommand)).toHaveLength(1);
    const logged = lines.join('');
    expect(logged).toContain('binding-changed');
    expect(logged).not.toContain('arn:aws:kms');
  });

  it('alarms on a MODIFY that changes tier', async () => {
    await watch()(event(record('MODIFY', image(KEY_ARN_A, 'vendor-key'), image(KEY_ARN_A, 'tenant-key'))));
    expect(cloudwatch.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  it('does not alarm on a MODIFY of counters or status', async () => {
    await watch()(event(record('MODIFY', image(KEY_ARN_A), { ...image(KEY_ARN_A), keyStatus: { S: 'REVOKED' } })));
    expect(cloudwatch.calls()).toHaveLength(0);
  });

  it('writes a 7-day tombstone on REMOVE, in the SYSTEM partition', async () => {
    await watch()(event(record('REMOVE', image(KEY_ARN_A))));
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.Key).toEqual({ PK: 'SYSTEM', SK: 'TOMBSTONE#tenant-a' });
    expect(update.ExpressionAttributeValues![':set_ttl']).toBe(Math.floor(NOW / 1000) + 7 * 24 * 3600);
    expect(cloudwatch.calls()).toHaveLength(0);
  });

  it('alarms on an INSERT while the tombstone exists', async () => {
    await watch()(event(record('INSERT', undefined, image(KEY_ARN_A))));
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe('attribute_exists(#PK)');
    expect(cloudwatch.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  it('does not alarm on a first INSERT (no tombstone), and creates nothing', async () => {
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    await watch()(event(record('INSERT', undefined, image(KEY_ARN_A))));
    expect(cloudwatch.calls()).toHaveLength(0);
  });

  it('ignores KEYARN# items', async () => {
    await watch()(event(record('MODIFY', image(KEY_ARN_A), image(KEY_ARN_B), `KEYARN#${KEY_ARN_A}`)));
    expect(cloudwatch.calls()).toHaveLength(0);
    expect(ddb.calls()).toHaveLength(0);
  });

  it('fails the batch when a write fails, so the on-failure destination gets it', async () => {
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(watch()(event(record('REMOVE', image(KEY_ARN_A))))).rejects.toThrow();
  });
});
