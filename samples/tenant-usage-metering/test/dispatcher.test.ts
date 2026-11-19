// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Dispatcher, type RequestSigner } from '../src/dispatcher/dispatcher';
import { sigV4Signer } from '../src/dispatcher/sigv4';
import type { SinkItem, UsageRecordItem } from '../src/shared/items';
import { Metrics } from '../src/shared/metrics';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const ddb = mockClient(db);
const secrets = new SecretsManagerClient({ region: 'eu-central-1' });
const secretsMock = mockClient(secrets);

const RECORD: UsageRecordItem = {
  PK: 'REC#r1',
  SK: 'META',
  recordId: 'r1',
  kind: 'HOURLY',
  tenantId: 'tenant-a',
  applicationId: 'demo-app',
  meterId: 'agent.tokens',
  meterVersion: 1,
  unit: 'tokens',
  hour: '2026-11-18T10',
  seq: 1,
  revision: 1,
  quantity: '10',
  total: '10',
  eventCount: 1,
  sinks: { s: { status: 'PENDING' } },
  createdAt: '2026-11-18T11:00:00Z',
};
const sinkItem = (overrides: Partial<SinkItem>): SinkItem =>
  ({ PK: 'SINK#s', SK: 'META', sinkId: 's', type: 'HTTP', enabled: true, endpoint: 'https://abc123.lambda-url.eu-central-1.on.aws/', createdBy: 'x', createdAt: 'x', ...overrides }) as SinkItem;

function setup(sink: SinkItem) {
  ddb.reset();
  secretsMock.reset();
  ddb.on(GetCommand).callsFake((input: { Key: { PK: string } }) => ({ Item: input.Key.PK === 'SINK#s' ? sink : RECORD }));
  ddb.on(UpdateCommand).resolves({});
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const signed: Array<{ service: string; region: string }> = [];
  const sign: RequestSigner = async (_url, init, target) => {
    signed.push(target);
    return { ...init.headers, authorization: 'AWS4-HMAC-SHA256 test' };
  };
  const dispatcher = new Dispatcher({
    db,
    tableName: 't',
    exportBucket: 'b',
    s3: new S3Client({ region: 'eu-central-1' }),
    secrets,
    send: async (url, init) => {
      sent.push({ url, headers: init.headers });
      return { status: 200 };
    },
    sign,
    metrics: new Metrics('test'),
  });
  return { dispatcher, sent, signed };
}

const message = { PK: RECORD.PK, SK: RECORD.SK, sinkId: 's', firstQueuedAt: new Date().toISOString() };

describe('AWS_IAM sinks (spec §4.4)', () => {
  test('the delivery is signed for the function URL, with no secret read', async () => {
    const { dispatcher, sent, signed } = setup(sinkItem({ auth: 'AWS_IAM' }));
    expect(await dispatcher.dispatch(message, 1)).toEqual({ done: true });
    expect(signed).toEqual([{ service: 'lambda', region: 'eu-central-1' }]);
    expect(sent[0].headers.authorization).toBe('AWS4-HMAC-SHA256 test');
    expect(secretsMock.calls()).toHaveLength(0);
  });

  test('a stored AWS_IAM sink to another host is never signed or sent', async () => {
    const { dispatcher, sent, signed } = setup(sinkItem({ auth: 'AWS_IAM', endpoint: 'https://billing.example.com/usage' }));
    const result = await dispatcher.dispatch(message, 1);
    expect(result.done).toBe(false);
    expect(signed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('sigV4Sign signs for the service and Region of the target', async () => {
    const headers = await sigV4Signer({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-only' })(
      'https://abc123.lambda-url.eu-central-1.on.aws/?x=1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { service: 'lambda', region: 'eu-central-1' },
    );
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/lambda\/aws4_request/);
    expect(headers.host).toBe('abc123.lambda-url.eu-central-1.on.aws');
  });
});
