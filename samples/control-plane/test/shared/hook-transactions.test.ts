// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { DataModel, DynamoDBItem } from '../../src/shared/data-model';
import {
  HookExistsError,
  HookGoneError,
  HookLimitError,
  HookTransactions,
} from '../../src/shared/hook-transactions';
import {
  AmbiguousTransactionError,
  DynamoDBRepository,
  RACE_RETRY_ATTEMPTS,
  TransactionRaceError,
} from '../../src/shared/repository';

/**
 * The hook counter transactions (spec P-6, R-39): two code paths, both
 * transactional, and nothing else writes `hookCount`.
 */

interface TestHook {
  hookId: string;
}
interface TestHookItem extends DynamoDBItem {
  hookId: string;
}
const dataModel: DataModel<TestHook, TestHookItem> = {
  toItem: (h) => ({ PK: 'HOOK', SK: `HOOK#${h.hookId}`, hookId: h.hookId }),
  fromItem: (i) => ({ hookId: i.hookId }),
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const transactions = new HookTransactions<TestHook, TestHookItem>('test-table', dataModel, client);
const COUNTER = { PK: 'HOOK', SK: 'META' };

function canceled(codes: string[]): Error {
  const error = new Error('canceled');
  error.name = 'TransactionCanceledException';
  (error as unknown as { CancellationReasons: unknown }).CancellationReasons = codes.map((Code) => ({ Code }));
  return error;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
});

describe('createHook', () => {
  const params = { hook: { hookId: 'g' }, counterKey: COUNTER, maxHooks: 5, updatedAt: '2026-01-01T00:00:00.000Z' };

  test('inserts the hook IF NOT EXISTS and claims a slot while the count is below the maximum, in one transaction', async () => {
    await transactions.createHook(params);

    const sent = ddbMock.commandCalls(TransactWriteCommand);
    expect(sent).toHaveLength(1);
    const [put, update] = sent[0].args[0].input.TransactItems!;
    expect(put.Put).toMatchObject({
      Item: { PK: 'HOOK', SK: 'HOOK#g' },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    expect(update.Update).toMatchObject({
      Key: COUNTER,
      UpdateExpression: 'SET #hookCount = if_not_exists(#hookCount, :zero) + :one, #updatedAt = :updatedAt',
      ConditionExpression: 'attribute_not_exists(#hookCount) OR #hookCount < :max',
      ExpressionAttributeValues: { ':max': 5 },
    });
  });

  test('a hook that exists (a concurrent create won) is HookExistsError, also when the counter refused too', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['ConditionalCheckFailed', 'None']));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(HookExistsError);
    ddbMock.on(TransactWriteCommand).rejects(canceled(['ConditionalCheckFailed', 'ConditionalCheckFailed']));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(HookExistsError);
  });

  test('the counter alone refusing is HookLimitError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['None', 'ConditionalCheckFailed']));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(HookLimitError);
  });

  test('a race on the shared counter is sent again, then succeeds (ADR-0050)', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(canceled(['None', 'TransactionConflict']))
      .resolves({});
    await transactions.createHook(params);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  test('races on every attempt are a TransactionRaceError, never ambiguous (ADR-0050)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['None', 'TransactionConflict']));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(TransactionRaceError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(RACE_RETRY_ATTEMPTS);
  });

  test('any other failure is ambiguous', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['None', 'None']));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(AmbiguousTransactionError);
    ddbMock.on(TransactWriteCommand).rejects(new Error('throttled'));
    await expect(transactions.createHook(params)).rejects.toBeInstanceOf(AmbiguousTransactionError);
  });
});

describe('deleteHook', () => {
  const params = { hookKey: { PK: 'HOOK', SK: 'HOOK#g' }, counterKey: COUNTER, updatedAt: '2026-01-01T00:00:00.000Z' };

  test('deletes the hook IF EXISTS and releases a slot IF hookCount > 0, in one transaction', async () => {
    await transactions.deleteHook(params);

    const [del, update] = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(del.Delete).toMatchObject({ Key: params.hookKey, ConditionExpression: 'attribute_exists(PK)' });
    expect(update.Update).toMatchObject({
      Key: COUNTER,
      UpdateExpression: 'SET #hookCount = #hookCount - :one, #updatedAt = :updatedAt',
      ConditionExpression: '#hookCount > :zero',
    });
  });

  test('a missing hook is HookGoneError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['ConditionalCheckFailed', 'None']));
    await expect(transactions.deleteHook(params)).rejects.toBeInstanceOf(HookGoneError);
  });

  test('a hook the counter does not count is never a silent success', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['None', 'ConditionalCheckFailed']));
    await expect(transactions.deleteHook(params)).rejects.toBeInstanceOf(AmbiguousTransactionError);
  });

  test('races on every attempt are a TransactionRaceError (ADR-0050)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['TransactionConflict', 'TransactionConflict']));
    await expect(transactions.deleteHook(params)).rejects.toBeInstanceOf(TransactionRaceError);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(RACE_RETRY_ATTEMPTS);
  });
});

describe('strongly consistent hook reads (R-39, R-40)', () => {
  const repo = new DynamoDBRepository<TestHook, TestHookItem>('test-table', dataModel, client);

  test('get asks for a consistent read only when told to', async () => {
    ddbMock.on(GetCommand).resolves({});
    await repo.get({ PK: 'HOOK', SK: 'HOOK#g' }, { consistentRead: true });
    await repo.get({ PK: 'HOOK', SK: 'HOOK#g' });
    const inputs = ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input);
    expect(inputs[0].ConsistentRead).toBe(true);
    expect(inputs[1]).not.toHaveProperty('ConsistentRead');
  });

  test('queryPartition passes ConsistentRead through, and not otherwise', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.queryPartition({ partitionKey: 'HOOK', sortKeyPrefix: 'HOOK#', consistentRead: true });
    await repo.queryPartition({ partitionKey: 'TENANT#x', sortKeyPrefix: 'DEPLOYMENT#' });
    const inputs = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(inputs[0].ConsistentRead).toBe(true);
    expect(inputs[1]).not.toHaveProperty('ConsistentRead');
  });
});

describe('exactly two code paths mutate hookCount (P-6)', () => {
  const root = join(__dirname, '..', '..', 'src');
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts')).map((f) => join(root, dir, f));

  test('only the hook transactions write the counter; PutHook, PutApplication and the workflow-facing code do not', () => {
    const writers = [...sources('shared'), ...sources('tenant')].filter((file) => {
      const text = readFileSync(file, 'utf8');
      // A write expression on the attribute: SET/ADD/REMOVE hookCount or an if_not_exists on it.
      return /(SET|ADD|REMOVE)\s+#?hookCount|if_not_exists\(#?hookCount/.test(text);
    });
    expect(writers.map((f) => f.slice(root.length + 1))).toEqual(['shared/hook-transactions.ts']);

    const text = readFileSync(join(root, 'shared', 'hook-transactions.ts'), 'utf8');
    const writes = text.match(/UpdateExpression: '[^']*hookCount[^']*'/g) ?? [];
    expect(writes).toHaveLength(2);
  });
});
