// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { AdminDeps } from '../src/api/deps';
import { updateSink } from '../src/api/sinks';
import type { SinkItem } from '../src/shared/items';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const ddb = mockClient(db);
const deps: AdminDeps = {
  db,
  now: () => Date.parse('2026-11-19T12:00:00Z'),
  config: { tableName: 't', fleetName: 'demo', recountWindowHours: 96, closeGraceMinutes: 60, blockedAccountIds: [], ingestPath: 'BUS' },
  startJob: async () => undefined,
};
const STORED: SinkItem = {
  PK: 'SINK#s',
  SK: 'META',
  sinkId: 's',
  type: 'HTTP',
  enabled: true,
  endpoint: 'https://abc123.lambda-url.eu-central-1.on.aws/',
  auth: 'AWS_IAM',
  createdBy: 'x',
  createdAt: '2026-11-19T11:00:00Z',
  version: 1,
};

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand).resolves({ Item: STORED });
  ddb.on(PutCommand).resolves({});
});

describe('UpdateSink on an AWS_IAM sink (spec §4.4)', () => {
  test('keeps auth and accepts another function URL', async () => {
    const updated = await updateSink(deps, { sinkId: 's', endpoint: 'https://def456.lambda-url.eu-central-1.on.aws/usage' });
    expect(updated.auth).toBe('AWS_IAM');
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ auth: 'AWS_IAM', version: 2 });
  });

  test('refuses a secretName', async () => {
    await expect(updateSink(deps, { sinkId: 's', secretName: 'demo/metering/sinks/s' })).rejects.toThrow(/no secretName/);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('refuses a move to a host that is not a function URL or API Gateway', async () => {
    await expect(updateSink(deps, { sinkId: 's', endpoint: 'https://billing.example.com/usage' })).rejects.toThrow(/function URL/);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});
