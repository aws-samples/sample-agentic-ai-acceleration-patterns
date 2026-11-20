// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { AdminDeps } from '../src/api/deps';
import { putEmitter, putTenantBinding } from '../src/api/registry';
import { Metrics } from '../src/shared/metrics';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const EMITTER_ID = '01JD00000000000000000000C1';
const ROLE = `demo-ue-${EMITTER_ID}`;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const ddb = mockClient(db);
const ctx = { caller: { accountId: '111122223333', roleName: 'registrar', roleArn: 'arn:aws:iam::111122223333:role/registrar' }, requestId: 'r' };
const jobs: string[] = [];
const deps: AdminDeps = {
  db,
  now: () => NOW,
  config: { tableName: 't', fleetName: 'demo', recountWindowHours: 96, closeGraceMinutes: 60, blockedAccountIds: [], ingestPath: 'BUS' },
  startJob: async (job) => {
    jobs.push(job.kind);
  },
};
const expired = Math.floor(NOW / 1000) - 60;

function items(byKey: Record<string, Record<string, unknown>>) {
  ddb.reset();
  ddb.on(GetCommand).callsFake((input: { Key: { PK: string; SK: string } }) => ({ Item: byKey[`${input.Key.PK}|${input.Key.SK}`] }));
  ddb.on(TransactWriteCommand).resolves({});
}
const transactions = () => ddb.commandCalls(TransactWriteCommand).map((call) => call.args[0].input.TransactItems!);

describe('registrations under TTL', () => {
  test('a first PutEmitter guards the id item against another account', async () => {
    items({});
    await putEmitter(deps, ctx, { emitterId: EMITTER_ID, applicationId: 'demo-app', accountId: '111122223333', trace: {} });
    const [writes] = transactions();
    expect(writes[0].Put?.ConditionExpression).toBe('attribute_not_exists(PK) OR expiresAt <= :now OR (accountId = :a AND applicationId = :app)');
    expect(writes[1].Put?.ConditionExpression).toBe('attribute_not_exists(PK) OR expiresAt <= :now');
  });

  test('an expired id item of another account does not block a new registration', async () => {
    items({ [`EMITTER#${EMITTER_ID}|META`]: { emitterId: EMITTER_ID, accountId: '444455556666', roleName: ROLE, applicationId: 'other', expiresAt: expired } });
    const emitter = await putEmitter(deps, ctx, { emitterId: EMITTER_ID, applicationId: 'demo-app', accountId: '111122223333', trace: {} });
    expect(emitter.status).toBe('ACTIVE');
  });

  test('an ACTIVE emitter whose id item TTL removed gets its id item back', async () => {
    items({ [`ROLE#111122223333#${ROLE}|META`]: { emitterId: EMITTER_ID, accountId: '111122223333', roleName: ROLE, applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-01T00:00:00Z' } });
    await putEmitter(deps, ctx, { emitterId: EMITTER_ID, applicationId: 'demo-app', accountId: '111122223333', trace: {} });
    const [writes] = transactions();
    expect(writes).toHaveLength(1);
    expect(writes[0].Put?.Item).toMatchObject({ PK: `EMITTER#${EMITTER_ID}`, accountId: '111122223333' });
  });

  test('a binding rewrites its tenant copy and starts the resend a new billing account needs', async () => {
    jobs.length = 0;
    items({
      [`EMITTER#${EMITTER_ID}|META`]: { emitterId: EMITTER_ID, accountId: '111122223333', roleName: ROLE, applicationId: 'demo-app' },
      [`ROLE#111122223333#${ROLE}|META`]: { emitterId: EMITTER_ID, accountId: '111122223333', roleName: ROLE, applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-01T00:00:00Z' },
      [`EMITTER#${EMITTER_ID}|TENANT#t1`]: { emitterId: EMITTER_ID, tenantId: 't1', applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-01T00:00:00Z' },
    });
    const out = await putTenantBinding(deps, ctx, { emitterId: EMITTER_ID, tenantId: 't1', applicationId: 'demo-app', billingAccount: 'acct-1', trace: {} });
    expect(jobs).toEqual(['RESEND_BLOCKED']);
    expect(out.resendJobId).toBeDefined();
    const [first] = transactions();
    expect(first[0].Put?.Item).toMatchObject({ PK: `EMITTER#${EMITTER_ID}`, billingAccount: 'acct-1', resendPending: true });
    expect(first[1].Put?.Item).toMatchObject({ PK: 'TENANT#t1', SK: `APP#demo-app#EMITTER#${EMITTER_ID}`, billingAccount: 'acct-1' });
    expect(first[1].Put?.ConditionExpression).toBeUndefined();
    // The flag is cleared alone, on a condition that it is still set.
    const clears = ddb.commandCalls(UpdateCommand).map((call) => call.args[0].input);
    expect(clears.map((input) => [input.UpdateExpression, input.ConditionExpression])).toEqual([
      ['REMOVE resendPending', 'resendPending = :true AND billingAccount = :b'],
      ['REMOVE resendPending', 'resendPending = :true AND billingAccount = :b'],
    ]);
    expect(out.binding).not.toHaveProperty('resendPending');
  });

  test('a binding left with resendPending starts its resend on the next Put', async () => {
    jobs.length = 0;
    items({
      [`EMITTER#${EMITTER_ID}|META`]: { emitterId: EMITTER_ID, accountId: '111122223333', roleName: ROLE, applicationId: 'demo-app' },
      [`ROLE#111122223333#${ROLE}|META`]: { emitterId: EMITTER_ID, accountId: '111122223333', roleName: ROLE, applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-01T00:00:00Z' },
      [`EMITTER#${EMITTER_ID}|TENANT#t1`]: { emitterId: EMITTER_ID, tenantId: 't1', applicationId: 'demo-app', status: 'ACTIVE', activeFrom: '2026-11-01T00:00:00Z', billingAccount: 'acct-1', resendPending: true },
    });
    await putTenantBinding(deps, ctx, { emitterId: EMITTER_ID, tenantId: 't1', applicationId: 'demo-app', billingAccount: 'acct-1', trace: {} });
    expect(jobs).toEqual(['RESEND_BLOCKED']);
  });
});

describe('metrics', () => {
  test('a dimensioned metric is also written without dimensions, which the alarms read', () => {
    const lines: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const metrics = new Metrics('Test');
    metrics.add('DeliveriesFailed', 1, { sinkId: 's1' });
    metrics.flush();
    write.mockRestore();
    expect(JSON.parse(lines[0])._aws.CloudWatchMetrics[0].Dimensions).toEqual([[], ['sinkId']]);
  });
});
