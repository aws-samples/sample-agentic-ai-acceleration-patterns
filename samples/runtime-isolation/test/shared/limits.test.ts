// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { LIMITER_CLIENT, TenantLimiter, type TenantLimitsConfig, windowKey } from '../../src/shared/limits';

/** ADR-0020: one conditional UpdateItem per request, 429 on a limit hit, fail-open on a DynamoDB fault. */
describe('TenantLimiter', () => {
  const dynamo = mockClient(DynamoDBClient);
  const NOW = 1_700_000_000_000;
  const MINUTE = Math.floor(NOW / 60_000);
  let logs: string[];
  let outSpy: jest.SpyInstance;

  beforeEach(() => {
    dynamo.reset();
    dynamo.on(UpdateItemCommand).resolves({});
    logs = [];
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((l: any) => {
      logs.push(String(l).trimEnd());
      return true;
    });
  });
  afterEach(() => outSpy.mockRestore());

  const limiter = (overrides: Partial<TenantLimitsConfig> = {}) =>
    new TenantLimiter({ tableName: 'TenantLimits', requestsPerMinute: 60, ...overrides }, { dynamo: new DynamoDBClient({}), now: () => NOW });

  it('the default client waits a bounded time under impairment (ADR-0023): two attempts, short timeouts', async () => {
    const client = (new TenantLimiter({ tableName: 'TenantLimits', requestsPerMinute: 60 }) as any).dynamo as DynamoDBClient;
    expect(await client.config.maxAttempts()).toBe(2);
    const handler = await (client.config.requestHandler as any).configProvider;
    expect(handler).toMatchObject({ connectionTimeout: LIMITER_CLIENT.connectionTimeout, requestTimeout: LIMITER_CLIENT.requestTimeout });
  });

  it('the window key is TENANT#<id>#<epoch minute>', () => {
    expect(windowKey('tenant-a', NOW)).toBe(`TENANT#tenant-a#${MINUTE}`);
    expect(windowKey('tenant-a', NOW + 60_000)).toBe(`TENANT#tenant-a#${MINUTE + 1}`);
  });

  it('admit sends one conditional UpdateItem that adds one request under :maxRequests', async () => {
    expect(await limiter().admit('tenant-a')).toBe('admitted');
    expect(dynamo).toHaveReceivedCommandTimes(UpdateItemCommand, 1);
    const input = dynamo.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.TableName).toBe('TenantLimits');
    expect(input.Key).toEqual({ PK: { S: `TENANT#tenant-a#${MINUTE}` } });
    expect(input.UpdateExpression).toContain('ADD requests :one');
    expect(input.ConditionExpression).toContain(':maxRequests');
    expect(input.ConditionExpression).not.toContain(':maxTokens');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':one': { N: '1' }, ':maxRequests': { N: '60' } });
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':maxTokens');
    expect(Number(input.ExpressionAttributeValues![':ttl'].N)).toBeGreaterThan(NOW / 1000);
  });

  it('adds the token condition only when a token limit is set', async () => {
    await limiter({ outputTokensPerMinute: 5000 }).admit('tenant-a');
    const input = dynamo.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain(':maxRequests');
    expect(input.ConditionExpression).toContain(':maxTokens');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':maxTokens': { N: '5000' } });
  });

  it('a token limit alone (requestsPerMinute 0) still checks, with no request condition', async () => {
    await limiter({ requestsPerMinute: 0, outputTokensPerMinute: 5000 }).admit('tenant-a');
    const input = dynamo.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).not.toContain(':maxRequests');
    expect(input.ConditionExpression).toContain(':maxTokens');
  });

  it('a ConditionalCheckFailedException is a limit hit: limited', async () => {
    dynamo.on(UpdateItemCommand).rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));
    expect(await limiter().admit('tenant-a')).toBe('limited');
  });

  it('an error named ConditionalCheckFailedException from another class is also limited', async () => {
    const error = new Error('x');
    error.name = 'ConditionalCheckFailedException';
    dynamo.on(UpdateItemCommand).rejects(error);
    expect(await limiter().admit('tenant-a')).toBe('limited');
  });

  it('any other DynamoDB error fails open: admitted, with an error log line carrying the name only', async () => {
    const error = new Error('throttled with secret-detail');
    error.name = 'ProvisionedThroughputExceededException';
    dynamo.on(UpdateItemCommand).rejects(error);
    expect(await limiter().admit('tenant-a')).toBe('admitted');
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.level === 'ERROR');
    expect(line).toMatchObject({ message: 'tenant limit check failed; admitting', tenantId: 'tenant-a', error: 'ProvisionedThroughputExceededException' });
    expect(logs.join('\n')).not.toContain('secret-detail');
  });

  it('no request limit and no token limit: no DynamoDB call', async () => {
    expect(await limiter({ requestsPerMinute: 0 }).admit('tenant-a')).toBe('admitted');
    expect(dynamo).toHaveReceivedCommandTimes(UpdateItemCommand, 0);
  });

  it('recordOutputTokens adds the tokens to the current window when a token limit is set', async () => {
    await limiter({ outputTokensPerMinute: 5000 }).recordOutputTokens('tenant-a', 42.7);
    expect(dynamo).toHaveReceivedCommandTimes(UpdateItemCommand, 1);
    const input = dynamo.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: { S: `TENANT#tenant-a#${MINUTE}` } });
    expect(input.UpdateExpression).toContain('ADD outputTokens :n');
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.ExpressionAttributeValues).toMatchObject({ ':n': { N: '42' } });
  });

  it('recordOutputTokens does nothing without a token limit or for n <= 0', async () => {
    await limiter().recordOutputTokens('tenant-a', 42);
    await limiter({ outputTokensPerMinute: 5000 }).recordOutputTokens('tenant-a', 0);
    await limiter({ outputTokensPerMinute: 5000 }).recordOutputTokens('tenant-a', -3);
    await limiter({ outputTokensPerMinute: 5000 }).recordOutputTokens('tenant-a', Number.NaN);
    expect(dynamo).toHaveReceivedCommandTimes(UpdateItemCommand, 0);
  });

  it('recordOutputTokens swallows a DynamoDB error and logs the name only', async () => {
    const error = new Error('boom secret-detail');
    error.name = 'InternalServerError';
    dynamo.on(UpdateItemCommand).rejects(error);
    await expect(limiter({ outputTokensPerMinute: 5000 }).recordOutputTokens('tenant-a', 10)).resolves.toBeUndefined();
    expect(logs.map((l) => JSON.parse(l)).find((l) => l.level === 'ERROR')).toMatchObject({ error: 'InternalServerError', tenantId: 'tenant-a' });
    expect(logs.join('\n')).not.toContain('secret-detail');
  });
});
