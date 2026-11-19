// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Test doubles for the sweeper: an in-memory route table behind
 * `aws-sdk-client-mock` (`ListKeys`, `GetKey`), an in-memory sweeper table
 * behind the DynamoDB document client mock, a Lambda mock that records the
 * pages started, and a capture of the function's stdout lines. Tenants are
 * ULIDs, domains are example.com, accounts are obvious fakes.
 */

import {
  CloudFrontKeyValueStoreClient,
  GetKeyCommand,
  ListKeysCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { SweeperPageEvent } from '../../src/shared/contracts';
import type { ChallengeOutcome } from '../../src/shared/dns-challenge';
import type { RecheckDeps } from '../../src/sweeper/recheck';

export const EDGE_ACCOUNT = '123456789012';
export const ROUTE_TABLE_ARN = `arn:aws:cloudfront::${EDGE_ACCOUNT}:key-value-store/11111111-2222-3333-4444-555555555555`;
export const TABLE = 'sweeper-table';
export const FUNCTION_NAME = 'tenant-front-door-sweeper';
export const DISTRIBUTION_ID = 'E1EXAMPLE0DIST';

/** Stored (lower-case) ULID tenant ids. */
export const TENANT_A = '01hzx8k9p0qrst7vwxyz1a2b3c';
export const TENANT_B = '01hzx8k9p0qrst7vwxyz1a2b3e';
export const TENANT_C = '01hzx8k9p0qrst7vwxyz1a2b3f';

export const TOKEN_A = 'A'.repeat(43);
export const TOKEN_B = 'B'.repeat(43);

/** 2026-11-20 10:00 UTC. */
export const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);
export const TODAY = '2026-11-20';
export const YESTERDAY = '2026-11-19';

export function tenantValue(fields: { d?: string; dk?: string; dx?: number } = {}): string {
  const e: Record<string, unknown> = { v: 1, c: '01hzx8k9p0qrst7vwxyz1a2b3d', ac: '111111111111', dt: 1795080000000, s: 'active', n: 'Example' };
  if (fields.d !== undefined) e.d = fields.d;
  if (fields.dk !== undefined) e.dk = fields.dk;
  if (fields.dx !== undefined) e.dx = fields.dx;
  return JSON.stringify(e);
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

export const kvs = mockClient(CloudFrontKeyValueStoreClient);
export const routeTable = new Map<string, string>();

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'not found', $metadata: {} });
}

export function installRouteTable(): void {
  kvs.on(ListKeysCommand).callsFake((input: { NextToken?: string; MaxResults?: number }) => {
    const keys = [...routeTable.keys()].sort();
    const start = input.NextToken === undefined ? 0 : Number(input.NextToken);
    const max = input.MaxResults ?? 50;
    const slice = keys.slice(start, start + max);
    const next = start + max < keys.length ? String(start + max) : undefined;
    return { Items: slice.map((Key) => ({ Key, Value: routeTable.get(Key) })), NextToken: next };
  });
  kvs.on(GetKeyCommand).callsFake((input: { Key: string }) => {
    const value = routeTable.get(input.Key);
    if (value === undefined) throw notFound();
    return { Key: input.Key, Value: value };
  });
}

// ---------------------------------------------------------------------------
// Sweeper table
// ---------------------------------------------------------------------------

export const ddb = mockClient(DynamoDBDocumentClient);
export const table = new Map<string, Record<string, any>>();

const k = (key: Record<string, any>): string => `${key.pk}|${key.sk}`;

export function entryItem(tenantId: string, domain: string): Record<string, any> | undefined {
  return table.get(`ENTRY|${tenantId}#${domain}`);
}

export function runItem(day: string): Record<string, any> | undefined {
  return table.get(`RUN|${day}`);
}

export function seedEntry(tenantId: string, domain: string, fields: Record<string, any>): void {
  table.set(`ENTRY|${tenantId}#${domain}`, { pk: 'ENTRY', sk: `${tenantId}#${domain}`, ...fields });
}

export function seedRun(day: string, fields: Record<string, any>): void {
  table.set(`RUN|${day}`, { pk: 'RUN', sk: day, ...fields });
}

/**
 * Evaluates the entry write's condition the way DynamoDB would: the item
 * is absent, its day is earlier, or it is today and its outcome is among
 * the `:weakerN` values the write names.
 */
function entryConditionHolds(item: Record<string, any> | undefined, values: Record<string, any>): boolean {
  if (item === undefined) return true;
  if (item.lastCheckedDay < values[':today']) return true;
  const weaker = Object.entries(values).filter(([name]) => name.startsWith(':weaker')).map(([, v]) => v);
  return item.lastCheckedDay === values[':today'] && weaker.includes(item.lastOutcome);
}

export function installTable(): void {
  ddb.on(GetCommand).callsFake((input: { Key: Record<string, any> }) => {
    const item = table.get(k(input.Key));
    if (item === undefined) return { Item: undefined };
    // A copy in this realm: the code under test checks `instanceof Set`.
    const copy = { ...item };
    if (item.pagesFinished !== undefined) copy.pagesFinished = new Set(item.pagesFinished);
    return { Item: copy };
  });
  ddb.on(UpdateCommand).callsFake((input: { Key: Record<string, any>; UpdateExpression: string; ExpressionAttributeValues: Record<string, any> }) => {
    const id = k(input.Key);
    const values = input.ExpressionAttributeValues;
    const item = table.get(id);
    if (input.Key.pk === 'RUN') {
      const next = { ...(item ?? { pk: 'RUN', sk: input.Key.sk }) };
      if (input.UpdateExpression.startsWith('ADD')) {
        next.pagesFinished = new Set([...(next.pagesFinished ?? []), ...values[':page']]);
        next.expiresAt ??= values[':expires'];
      } else {
        next.pagesStarted = values[':started'];
        next.expiresAt = values[':expires'];
      }
      table.set(id, next);
      return {};
    }
    if (!entryConditionHolds(item, values)) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
    }
    table.set(id, {
      pk: input.Key.pk,
      sk: input.Key.sk,
      lastCheckedDay: values[':today'],
      lastOutcome: values[':outcome'],
      missStreak: values[':missStreak'],
      errorStreak: values[':errorStreak'],
      missBefore: values[':missBefore'],
      errorBefore: values[':errorBefore'],
    });
    return {};
  });
  ddb.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, any>; Limit?: number }) => {
    const v = input.ExpressionAttributeValues;
    if (v[':run'] !== undefined) {
      const items = [...table.values()].filter((i) => i.pk === 'RUN' && i.sk < v[':day']).sort((a, b) => (a.sk < b.sk ? -1 : 1));
      return { Items: items.slice(0, input.Limit ?? items.length) };
    }
    return { Items: [...table.values()].filter((i) => i.pk === 'ENTRY').map((i) => ({ sk: i.sk })) };
  });
  ddb.on(BatchWriteCommand).callsFake((input: { RequestItems: Record<string, { DeleteRequest: { Key: Record<string, any> } }[]> }) => {
    for (const r of input.RequestItems[TABLE]) table.delete(k(r.DeleteRequest.Key));
    return { UnprocessedItems: {} };
  });
}

// ---------------------------------------------------------------------------
// Lambda and stdout
// ---------------------------------------------------------------------------

export const lambda = mockClient(LambdaClient);

export function startedPages(): SweeperPageEvent[] {
  return lambda.commandCalls(InvokeCommand).map((c) => {
    expect(c.args[0].input.InvocationType).toBe('Event');
    expect(c.args[0].input.FunctionName).toBe(FUNCTION_NAME);
    return JSON.parse(Buffer.from(c.args[0].input.Payload as Uint8Array).toString('utf8'));
  });
}

let written: string[] = [];

/** Every stdout line written since the last `resetAll`, parsed. */
export function logLines(): Record<string, any>[] {
  return written.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

/** The raw stdout text, to check that no token appears in it. */
export function stdoutText(): string {
  return written.join('');
}

/** The EMF values of `metric` written so far. */
export function metricValues(metric: string): number[] {
  return logLines().filter((l) => l._aws?.CloudWatchMetrics?.[0]?.Metrics?.[0]?.Name === metric).map((l) => l[metric]);
}

export function resetAll(): void {
  kvs.reset();
  ddb.reset();
  lambda.reset();
  routeTable.clear();
  table.clear();
  written = [];
  installRouteTable();
  installTable();
  lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
}

/** Challenge outcomes by domain; a domain not listed passes. */
export const challengeOutcomes = new Map<string, ChallengeOutcome>();

export function recheckDeps(overrides: Partial<RecheckDeps> = {}): RecheckDeps {
  return {
    kvs: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
    kvsOnce: new CloudFrontKeyValueStoreClient({ region: 'us-east-1' }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    lambda: new LambdaClient({ region: 'eu-central-1' }),
    routeTableArn: ROUTE_TABLE_ARN,
    tableName: TABLE,
    functionName: FUNCTION_NAME,
    now: () => NOW,
    challenge: async (domain) => challengeOutcomes.get(domain) ?? 'pass',
    ...overrides,
  };
}
