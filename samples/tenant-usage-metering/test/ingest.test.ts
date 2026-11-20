// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { createAdminHandler, createAdminService } from '../src/api/handler';
import { Ingest } from '../src/ingest/ingest';
import { createIngestHandler } from '../src/ingest/ingest.function';
import type { EnrichedUsageEvent } from '../src/shared/usage-event';

const NOW = Date.parse('2026-11-18T12:30:00Z');
const EMITTER_ID = '01JD00000000000000000000E1';
const ROLE = `demo-ue-${EMITTER_ID}`;
const CALLER = `arn:aws:sts::111122223333:assumed-role/${ROLE}/emitter-1`;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const ddb = mockClient(db);

const emitterItem = {
  PK: `ROLE#111122223333#${ROLE}`,
  SK: 'META',
  emitterId: EMITTER_ID,
  applicationId: 'demo-app',
  accountId: '111122223333',
  roleName: ROLE,
  status: 'ACTIVE',
  activeFrom: '2026-11-18T00:00:00Z',
};
const bindingItem = { emitterId: EMITTER_ID, tenantId: 'tenant-a', applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-18T00:00:00Z' };
const meterItem = { meterId: 'agent.tokens', version: 1, unit: 'tokens', rule: 'SUM', effectiveFrom: '2026-11-01T00', status: 'ACTIVE' };

function setup(counter: { admission?: number; refusals?: number } = {}) {
  ddb.reset();
  ddb.on(GetCommand).callsFake((input: { Key: { PK: string; SK: string } }) => {
    if (input.Key.PK.startsWith('ROLE#') && input.Key.PK.endsWith(ROLE)) return { Item: emitterItem };
    if (input.Key.SK === 'TENANT#tenant-a') return { Item: bindingItem };
    return {};
  });
  ddb.on(QueryCommand).resolves({ Items: [meterItem] });
  ddb.on(UpdateCommand).callsFake((input: { Key: { SK: string }; ExpressionAttributeValues: Record<string, number> }) => {
    const n = input.ExpressionAttributeValues[':n'];
    const prior = input.Key.SK.startsWith('MIN#') ? (counter.admission ?? 0) : (counter.refusals ?? 0);
    return { Attributes: { count: prior + n } };
  });
  const published: EnrichedUsageEvent[] = [];
  const errorObjects: Array<{ key: string; body: string }> = [];
  const ingest = new Ingest({
    db,
    now: () => NOW,
    config: { fleetName: 'demo', tableName: 't', recountWindowHours: 96, maxEventsPerEmitterPerMinute: 3, maxRefusedPerEmitterPerHour: 1 },
    publish: async (events) => {
      published.push(...events);
      return new Set(events.map((_, i) => i));
    },
    writeErrorObject: async (key, body) => {
      errorObjects.push({ key, body });
    },
  });
  return { ingest, published, errorObjects, handler: createIngestHandler(ingest) };
}

const request = (body: unknown, userArn: string | null = CALLER): APIGatewayProxyEvent =>
  ({
    httpMethod: 'POST',
    path: '/usage-events',
    resource: '/usage-events',
    headers: { 'content-type': 'application/json' },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: { requestId: 'req-1', identity: { userArn } },
  }) as unknown as APIGatewayProxyEvent;

const good = (eventId: string, overrides: Record<string, unknown> = {}) => ({
  eventId,
  tenantId: 'tenant-a',
  meterId: 'agent.tokens',
  value: '5',
  time: '2026-11-18T12:10:00Z',
  ...overrides,
});

describe('ingest door (spec §3.2, §5)', () => {
  test('a body over 1,048,576 bytes is a 413 before anything is read', async () => {
    const { handler } = setup();
    const response = await handler(request(`{"events":["${'é'.repeat(524_289)}"]}`));
    expect(response.statusCode).toBe(413);
    expect(ddb.calls()).toHaveLength(0);
  });

  test('a caller that is not a registered emitter role gets 403 and nothing is stored', async () => {
    const { handler, published, errorObjects } = setup();
    expect(
      (await handler(request({ events: [good('01JD0000000000000000000001')] }, 'arn:aws:sts::111122223333:assumed-role/other/s')))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await handler(
          request(
            { events: [good('01JD0000000000000000000001')] },
            'arn:aws:sts::444455556666:assumed-role/demo-ue-01JD00000000000000000000E2/s',
          ),
        )
      ).statusCode,
    ).toBe(403);
    expect(published).toHaveLength(0);
    expect(errorObjects).toHaveLength(0);
  });

  test('each event is judged alone; identity comes from the caller, never the body', async () => {
    const { handler, published, errorObjects } = setup();
    const response = await handler(
      request({
        events: [
          good('01JD0000000000000000000001', { applicationId: 'spoofed' }),
          good('01JD0000000000000000000002'),
          good('01JD0000000000000000000003', { tenantId: 'tenant-b' }),
        ],
      }),
    );
    expect(response.statusCode).toBe(200);
    const results = JSON.parse(response.body).results;
    expect(results).toEqual([
      { eventId: '01JD0000000000000000000001', result: 'REFUSED', reason: 'BAD_SHAPE' },
      { eventId: '01JD0000000000000000000002', result: 'ACCEPTED' },
      { eventId: '01JD0000000000000000000003', result: 'REFUSED', reason: 'TENANT_NOT_BOUND' },
    ]);
    expect(published).toEqual([
      expect.objectContaining({
        eventId: '01JD0000000000000000000002',
        applicationId: 'demo-app',
        emitterId: EMITTER_ID,
        emitterAccountId: '111122223333',
        emitterRole: ROLE,
        receivedAt: '2026-11-18T12:30:00.000Z',
      }),
    ]);
    // Both refusals are stored: BAD_SHAPE under the cap of 1, TENANT_NOT_BOUND always.
    expect(errorObjects).toHaveLength(1);
    expect(errorObjects[0].key).toMatch(/^error\/hour=2026-11-18T12\//);
    expect(JSON.parse(errorObjects[0].body).events.map((e: { reason: string }) => e.reason)).toEqual(['BAD_SHAPE', 'TENANT_NOT_BOUND']);
  });

  test('events over the per-emitter minute limit are RETRY, refusals over the cap are not stored', async () => {
    const { handler, errorObjects } = setup({ admission: 1, refusals: 1 });
    const response = await handler(
      request({
        events: [
          good('01JD0000000000000000000001', { time: 'nope' }),
          good('01JD0000000000000000000002'),
          good('01JD0000000000000000000003'),
        ],
      }),
    );
    const results = JSON.parse(response.body).results.map((r: { result: string }) => r.result);
    expect(results).toEqual(['REFUSED', 'ACCEPTED', 'RETRY']);
    expect(errorObjects).toHaveLength(0);
  });

  test('a null entry is BAD_SHAPE alone; a batch of 101 is a 400', async () => {
    const { handler } = setup();
    const ok = await handler(request({ events: [null, good('01JD0000000000000000000002')] }));
    expect(JSON.parse(ok.body).results.map((r: { result: string }) => r.result)).toEqual(['REFUSED', 'ACCEPTED']);
    const tooMany = await handler(
      request({ events: Array.from({ length: 101 }, (_, i) => good(`01JD00000000000000000${String(i).padStart(5, '0')}`)) }),
    );
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('admin function (spec §3.2)', () => {
  const lists = {
    registrar: ['arn:aws:iam::111122223333:role/registrar'],
    operator: ['arn:aws:iam::111122223333:role/operator'],
    reader: [],
  };
  const adminRequest = (method: string, path: string, resource: string, userArn: string, body?: unknown): APIGatewayProxyEvent =>
    ({
      ...request(body ?? null, userArn),
      httpMethod: method,
      path,
      resource,
      body: body === undefined ? null : JSON.stringify(body),
    }) as APIGatewayProxyEvent;

  test('an operator cannot register an emitter, and a registrar cannot read meters', async () => {
    ddb.reset();
    const handler = createAdminHandler(
      createAdminService(
        {
          db,
          config: {
            tableName: 't',
            fleetName: 'demo',
            recountWindowHours: 96,
            closeGraceMinutes: 60,
            blockedAccountIds: [],
            ingestPath: 'BUS',
          },
          startJob: async () => {},
        },
        lists,
      ),
    );
    const put = await handler(
      adminRequest(
        'PUT',
        `/emitters/${EMITTER_ID}`,
        '/emitters/{emitterId}',
        'arn:aws:sts::111122223333:assumed-role/operator/session-1',
        { applicationId: 'demo-app', accountId: '111122223333' },
      ),
    );
    expect(put.statusCode).toBe(403);
    const list = await handler(adminRequest('GET', '/meters', '/meters', 'arn:aws:sts::111122223333:assumed-role/registrar/session-1'));
    expect(list.statusCode).toBe(403);
    expect(ddb.calls()).toHaveLength(0);
  });

  test('a delete takes the control-plane ids from headers in any case', async () => {
    ddb.reset();
    const binding = { PK: `EMITTER#${EMITTER_ID}`, SK: 'TENANT#tenant-b', emitterId: EMITTER_ID, tenantId: 'tenant-b', applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-18T00:00:00Z', createdBy: 'x', createdAt: '2026-11-18T00:00:00Z' };
    ddb.on(GetCommand).resolves({ Item: binding });
    const handler = createAdminHandler(
      createAdminService({ db, config: { tableName: 't', fleetName: 'demo', recountWindowHours: 96, closeGraceMinutes: 60, blockedAccountIds: [], ingestPath: 'BUS' }, startJob: async () => {} }, lists),
    );
    const event = adminRequest('DELETE', `/emitters/${EMITTER_ID}/tenants/tenant-b`, '/emitters/{emitterId}/tenants/{tenantId}', 'arn:aws:sts::111122223333:assumed-role/registrar/session-1');
    const withHeaders = { ...event, headers: { 'X-Control-Plane-Execution-Id': 'exec-9' }, multiValueHeaders: { 'X-Control-Plane-Execution-Id': ['exec-9'] } } as APIGatewayProxyEvent;
    const out = await handler(withHeaders);
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).binding).toMatchObject({ status: 'CLOSING', closedByExecutionId: 'exec-9' });
  });

  test('an emitter in a blocked account is refused ACCOUNT_NOT_ALLOWED', async () => {
    ddb.reset();
    const handler = createAdminHandler(
      createAdminService(
        {
          db,
          config: {
            tableName: 't',
            fleetName: 'demo',
            recountWindowHours: 96,
            closeGraceMinutes: 60,
            blockedAccountIds: ['111122223333'],
            ingestPath: 'BUS',
          },
          startJob: async () => {},
        },
        lists,
      ),
    );
    const put = await handler(
      adminRequest(
        'PUT',
        `/emitters/${EMITTER_ID}`,
        '/emitters/{emitterId}',
        'arn:aws:sts::111122223333:assumed-role/registrar/session-1',
        { applicationId: 'demo-app', accountId: '111122223333' },
      ),
    );
    expect(put.statusCode).toBe(409);
    expect(JSON.parse(put.body).reason).toBe('ACCOUNT_NOT_ALLOWED');
  });
});
