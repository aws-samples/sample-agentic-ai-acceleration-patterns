// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Sha256 } from '@aws-crypto/sha256-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
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

  test.each([
    ['another host', 'https://billing.example.com/usage'],
    ['plain http', 'http://abc123.lambda-url.eu-central-1.on.aws/'],
    ['a port', 'https://abc123.lambda-url.eu-central-1.on.aws:8443/'],
  ])('a stored AWS_IAM sink to %s fails at once, unsigned and unsent', async (_name, endpoint) => {
    const { dispatcher, sent, signed } = setup(sinkItem({ auth: 'AWS_IAM', endpoint }));
    expect(await dispatcher.dispatch(message, 1)).toEqual({ done: true });
    expect(signed).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues?.[':state']).toEqual({ status: 'FAILED', reason: 'AUTH_TARGET_INVALID' });
  });

  test('sigV4Signer signs for the target, over the delivery headers, with every value of a repeated query key', async () => {
    const headers = await sigV4Signer({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-only' })(
      'https://abc123.lambda-url.eu-central-1.on.aws/usage?tag=a&tag=b&x=1',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r1' }, body: '{}' },
      { service: 'lambda', region: 'eu-central-1' },
    );
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/lambda\/aws4_request/);
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(headers.authorization)![1].split(';');
    expect(signedHeaders).toEqual(expect.arrayContaining(['content-type', 'host', 'idempotency-key', 'x-amz-content-sha256', 'x-amz-date']));
    expect(headers.host).toBe('abc123.lambda-url.eu-central-1.on.aws');
  });

  test('a repeated query key is signed with every value (review v1 #5)', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-19T12:00:00Z') });
    try {
      const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-only' };
      const got = await sigV4Signer(credentials)(
        'https://abc123.lambda-url.eu-central-1.on.aws/usage?tag=a&tag=b',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        { service: 'lambda', region: 'eu-central-1' },
      );
      const expected = await new SignatureV4({ service: 'lambda', region: 'eu-central-1', credentials, sha256: Sha256 }).sign(
        new HttpRequest({
          method: 'POST',
          protocol: 'https:',
          hostname: 'abc123.lambda-url.eu-central-1.on.aws',
          path: '/usage',
          query: { tag: ['a', 'b'] },
          headers: { 'Content-Type': 'application/json', 'host': 'abc123.lambda-url.eu-central-1.on.aws' },
          body: '{}',
        }),
      );
      expect(got.authorization).toBe(expected.headers.authorization);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SECRET sinks (spec §4.4)', () => {
  test('the delivery carries the secret as a bearer token and is not signed', async () => {
    const { dispatcher, sent, signed } = setup(sinkItem({ endpoint: 'https://billing.example.com/usage', secretName: 'demo/metering/sinks/s' }));
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 't0ken' });
    expect(await dispatcher.dispatch(message, 1)).toEqual({ done: true });
    expect(signed).toHaveLength(0);
    expect(sent).toEqual([
      { url: 'https://billing.example.com/usage', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r1', 'Authorization': 'Bearer t0ken' } },
    ]);
  });
});
