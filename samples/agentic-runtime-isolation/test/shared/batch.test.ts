// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { batchGetAll, batchWriteAll, UnprocessedError } from '../../src/shared/batch';

/** Throttled batch keys and writes are resent with backoff, never read as absent (spec §3.6). */
describe('batch retries', () => {
  const doc = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  const sleeps: number[] = [];
  const options = { sleep: async (ms: number) => void sleeps.push(ms), random: () => 1 };

  beforeEach(() => {
    doc.reset();
    sleeps.length = 0;
  });

  it('BatchGetItem resends UnprocessedKeys and merges the responses', async () => {
    const tenant = { PK: 'TENANT#a', SK: '#SUB' };
    const cut = { PK: 'TENANT#a', SK: 'USER#u' };
    doc
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { t: [{ ...tenant, version: 1 }] }, UnprocessedKeys: { t: { Keys: [cut] } } })
      .resolvesOnce({ Responses: { t: [{ ...cut, cutTools: ['crm/update_case'] }] } });
    const out = await batchGetAll(client, { t: { Keys: [tenant, cut] } }, options);
    expect(out.t).toHaveLength(2);
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 2);
    expect(doc.commandCalls(BatchGetCommand)[1].args[0].input).toEqual({ RequestItems: { t: { Keys: [cut] } } });
    expect(sleeps).toEqual([50]);
  });

  it('BatchGetItem throws UnprocessedError when keys are still unread after the last attempt', async () => {
    doc.on(BatchGetCommand).resolves({ Responses: {}, UnprocessedKeys: { t: { Keys: [{ PK: 'x', SK: 'y' }] } } });
    await expect(batchGetAll(client, { t: { Keys: [{ PK: 'x', SK: 'y' }] } }, { ...options, maxAttempts: 3 })).rejects.toBeInstanceOf(UnprocessedError);
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 3);
    expect(sleeps).toEqual([50, 100]);
  });

  it('BatchWriteItem resends UnprocessedItems until none are left', async () => {
    const del = { DeleteRequest: { Key: { PK: 'TENANT#a', SK: 'USER#u' } } };
    doc.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: { t: [del] } }).resolvesOnce({});
    await batchWriteAll(client, { t: [del, { DeleteRequest: { Key: { PK: 'TENANT#a', SK: '#SUB' } } }] }, options);
    expect(doc).toHaveReceivedCommandTimes(BatchWriteCommand, 2);
    expect(doc.commandCalls(BatchWriteCommand)[1].args[0].input).toEqual({ RequestItems: { t: [del] } });
  });

  it('BatchWriteItem throws UnprocessedError naming the operation and the count', async () => {
    const del = { DeleteRequest: { Key: { PK: 'a', SK: 'b' } } };
    doc.on(BatchWriteCommand).resolves({ UnprocessedItems: { t: [del] } });
    const error = await batchWriteAll(client, { t: [del] }, { ...options, maxAttempts: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessedError);
    expect((error as UnprocessedError).operation).toBe('BatchWriteItem');
    expect((error as UnprocessedError).remaining).toBe(1);
  });

  it('nothing to read is no call', async () => {
    expect(await batchGetAll(client, { t: { Keys: [] } }, options)).toEqual({});
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 0);
  });
});
