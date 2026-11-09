// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant API (spec §5.2, §7.5; M-2, M-3, M-5, M-6), through the Smithy
 * SSDK and the Lambda wrapper: scope per route, the tenant from the
 * authoriser context only, the transaction that creates the row and counts
 * it, 409 and 429, and the presigned PUT's six signed headers.
 */

import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { BUCKET, captureStdout, DELIVERY_ID, KEY_ARN_A, mockSts, NOW, TABLE, tenantClients } from './runtime-helpers';
import { createHandler, createTenantApi } from '../src/api/handler';
import { signedHeadersOf, UPLOAD_SIGNED_HEADERS } from '../src/shared/presign';
import { attributeNames, UPLOAD_ROLE_ATTRIBUTES } from '../src/shared/registry';

const ddb = mockClient(DynamoDBDocumentClient);
mockSts();

const CONFIG = {
  tableName: TABLE,
  bucketName: BUCKET,
  allowedContentTypes: ['application/pdf', 'application/zip'],
  maxObjectSizeBytes: 1000,
  uploadUrlTtlSeconds: 900,
  maxInFlightPerTenant: 5,
};

function handler() {
  return createHandler(createTenantApi({ config: CONFIG, clients: tenantClients(), now: () => NOW, newId: () => DELIVERY_ID }));
}

function event(method: string, path: string, body?: object, scope = 'ingestion/deliver ingestion/read', tenantId = 'tenant-a'): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    resource: path,
    body: body === undefined ? null : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'host': 'abc123defg.execute-api.eu-central-1.amazonaws.com' },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    requestContext: {
      requestId: 'req-1',
      authorizer: { tenantId, sub: 'user-a1', scope },
    } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

const ACTIVE_KEY = { PK: 'TENANT#tenant-a', SK: 'KEY', tier: 'vendor-key', keyArn: KEY_ARN_A, keyStatus: 'ACTIVE', inFlight: 0 };
const PDF = { fileName: 'case-4711.pdf', contentType: 'application/pdf', sizeBytes: 812 };

beforeEach(() => {
  ddb.reset();
});

describe('CreateDelivery', () => {
  it('returns a PUT that signs all six headers and keeps the three x-amz-* as headers (M-6)', async () => {
    ddb.on(GetCommand).resolves({ Item: ACTIVE_KEY });
    ddb.on(TransactWriteCommand).resolves({});
    const response = await handler()(event('POST', '/tenant/deliveries', PDF));
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.deliveryId).toBe(DELIVERY_ID);
    const url = new URL(body.uploadUrl);
    expect(url.pathname).toBe(`/ingest/tenant-a/${DELIVERY_ID}`);
    expect(signedHeadersOf(body.uploadUrl).sort()).toEqual([...UPLOAD_SIGNED_HEADERS, 'host'].sort());
    for (const hoisted of ['x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id', 'x-amz-server-side-encryption-bucket-key-enabled']) {
      expect(url.searchParams.has(hoisted)).toBe(false);
    }
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(body.headers).toEqual({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': KEY_ARN_A,
      'x-amz-server-side-encryption-bucket-key-enabled': 'false',
      'If-None-Match': '*',
      'Content-Length': '812',
      'Content-Type': 'application/pdf',
    });
    expect(Date.parse(body.expiresAt)).toBe(NOW + 900_000);
    // No file name in the key (P-7).
    expect(url.pathname).not.toContain('case-4711');
  });

  it('creates the row with UpdateItem and attribute_not_exists(PK), counting it in one transaction (M-5, M-23)', async () => {
    ddb.on(GetCommand).resolves({ Item: ACTIVE_KEY });
    ddb.on(TransactWriteCommand).resolves({});
    await handler()(event('POST', '/tenant/deliveries', PDF));
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.Update !== undefined && i.Put === undefined && i.Delete === undefined)).toBe(true);
    expect(items[0].Update!.ConditionExpression).toBe('attribute_not_exists(#PK)');
    expect(items[0].Update!.Key).toEqual({ PK: 'TENANT#tenant-a', SK: `DELIVERY#${DELIVERY_ID}` });
    expect(items[1].Update!.ConditionExpression).toContain('#inFlight < :max');
    expect(items[1].Update!.ExpressionAttributeValues![':max']).toBe(5);
    for (const item of items) {
      for (const name of attributeNames(item.Update!)) {
        expect(UPLOAD_ROLE_ATTRIBUTES).toContain(name);
      }
    }
    // The file name lives on the row only.
    expect(JSON.stringify(items[0].Update!.ExpressionAttributeValues)).toContain('case-4711.pdf');
  });

  it('is 429 TooManyDeliveries when the inFlight condition fails (N-8)', async () => {
    ddb.on(GetCommand).resolves({ Item: ACTIVE_KEY });
    ddb.on(TransactWriteCommand).rejects(
      Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }),
    );
    const response = await handler()(event('POST', '/tenant/deliveries', PDF));
    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body)).toEqual({ code: 'TooManyDeliveries', message: expect.any(String), requestId: 'req-1' });
  });

  it.each([
    ['missing', undefined],
    ['REVOKED', { ...ACTIVE_KEY, keyStatus: 'REVOKED' }],
    ['DELETING', { ...ACTIVE_KEY, keyStatus: 'DELETING' }],
  ])('is 409 TenantKeyUnavailable when the key row is %s', async (_name, item) => {
    ddb.on(GetCommand).resolves({ Item: item });
    const response = await handler()(event('POST', '/tenant/deliveries', PDF));
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('TenantKeyUnavailable');
    // No tenant id and no key ARN in a /tenant/* error (spec §5.3).
    expect(response.body).not.toContain('tenant-a');
    expect(response.body).not.toContain('arn:aws:kms');
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('is 403 Forbidden without ingestion/deliver, before any registry call (M-2)', async () => {
    const response = await handler()(event('POST', '/tenant/deliveries', PDF, 'ingestion/read'));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).code).toBe('Forbidden');
    expect(ddb.calls()).toHaveLength(0);
  });

  it.each([
    ['a file name with a slash', { ...PDF, fileName: 'a/b.pdf' }],
    ['a file name with a quote', { ...PDF, fileName: 'a".pdf' }],
    ['a file name of 129 characters', { ...PDF, fileName: `${'a'.repeat(125)}.pdf` }],
    ['a type the deployment does not accept', { ...PDF, contentType: 'image/png' }],
    ['a size over the limit', { ...PDF, sizeBytes: 1001 }],
    ['a size of zero', { ...PDF, sizeBytes: 0 }],
  ])('is 400 ValidationError for %s (M-3)', async (_name, body) => {
    const response = await handler()(event('POST', '/tenant/deliveries', body));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('ValidationError');
    expect(ddb.calls()).toHaveLength(0);
  });

  it('logs the tenant and the delivery, never the URL or the file name', async () => {
    ddb.on(GetCommand).resolves({ Item: ACTIVE_KEY });
    ddb.on(TransactWriteCommand).resolves({});
    const { result, lines } = await captureStdout(() => handler()(event('POST', '/tenant/deliveries', PDF)));
    expect(result?.statusCode).toBe(201);
    const logged = lines.join('');
    expect(logged).toContain('"tenantId":"tenant-a"');
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).not.toContain('case-4711');
  });
});

describe('GetDelivery and ListDeliveries', () => {
  const ROW = {
    PK: 'TENANT#tenant-a',
    SK: `DELIVERY#${DELIVERY_ID}`,
    objectKey: `ingest/tenant-a/${DELIVERY_ID}`,
    fileName: 'case-4711.pdf',
    declaredContentType: 'application/pdf',
    declaredSizeBytes: 812,
    status: 'ACCEPTED',
    urlExpiresAt: 1,
    createdBy: 'user-a1',
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:01:00.000Z',
    landedKey: `documents/tenant-a/${DELIVERY_ID}`,
  };

  it('reads only the caller tenant partition; a missing row is 404', async () => {
    ddb.on(GetCommand).resolves({});
    const response = await handler()(event('GET', `/tenant/deliveries/${DELIVERY_ID}`, undefined, 'ingestion/read', 'tenant-b'));
    expect(response.statusCode).toBe(404);
    expect(ddb.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ PK: 'TENANT#tenant-b', SK: `DELIVERY#${DELIVERY_ID}` });
  });

  it('returns the row with ingestion/read and is 403 without it', async () => {
    ddb.on(GetCommand).resolves({ Item: ROW });
    const ok = await handler()(event('GET', `/tenant/deliveries/${DELIVERY_ID}`, undefined, 'ingestion/read'));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).delivery).toMatchObject({ deliveryId: DELIVERY_ID, status: 'ACCEPTED', landedKey: ROW.landedKey });
    const refused = await handler()(event('GET', `/tenant/deliveries/${DELIVERY_ID}`, undefined, 'ingestion/deliver'));
    expect(refused.statusCode).toBe(403);
  });

  it('lists newest first in the caller partition', async () => {
    ddb.on(QueryCommand).resolves({ Items: [ROW] });
    const response = await handler()(event('GET', '/tenant/deliveries', undefined, 'ingestion/read'));
    expect(response.statusCode).toBe(200);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ExpressionAttributeValues![':pk']).toBe('TENANT#tenant-a');
  });

  it('refuses a nextToken naming another tenant', async () => {
    const token = Buffer.from(JSON.stringify({ PK: 'TENANT#tenant-b', SK: `DELIVERY#${DELIVERY_ID}` })).toString('base64url');
    const e = event('GET', '/tenant/deliveries', undefined, 'ingestion/read');
    const response = await handler()({ ...e, queryStringParameters: { nextToken: token }, multiValueQueryStringParameters: { nextToken: [token] } });
    expect(response.statusCode).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe('the wrapper', () => {
  it('refuses a request without a verified caller', async () => {
    const e = event('POST', '/tenant/deliveries', PDF);
    const response = await handler()({ ...e, requestContext: { requestId: 'r' } as APIGatewayProxyEvent['requestContext'] });
    expect(response.statusCode).toBe(403);
  });
});
