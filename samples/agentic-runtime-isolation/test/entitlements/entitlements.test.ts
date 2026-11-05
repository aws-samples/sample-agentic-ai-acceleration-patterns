// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { decodeToken, encodeToken, EntitlementServiceImpl, type EntitlementContext } from '../../src/entitlements/entitlements';
import { planIndexKey, planKey, planMemberKey, tenantKey } from '../../src/shared/entitlements';

/**
 * The entitlement API service (spec §5.3, C-14): the plan index rows
 * (ListPlans and plan_in_use without a Scan), batch retries, and cut
 * validation (a cut names only what the tenant holds, ADR-0033).
 */
const TABLE = 'Entitlements';
const NOW = new Date('2026-11-04T10:00:00Z');
const doc = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const vendor: EntitlementContext = { side: 'vendor', callerArn: 'arn:aws:iam::111122223333:role/Vendor' };
const admin: EntitlementContext = { side: 'tenant-admin', tenantId: 'tenant-a', adminSub: 'admin-1', tenantClient: client };

function service(overrides: Partial<ConstructorParameters<typeof EntitlementServiceImpl>[0]> = {}) {
  return new EntitlementServiceImpl({
    tableName: TABLE,
    client,
    maxAgentsPerTenant: 100,
    maxToolsPerTenant: 1000,
    now: () => NOW,
    sleep: async () => undefined,
    ...overrides,
  });
}

/** The catalogue: crm has three tools, invoices two; agents default and billing are reserved. */
function catalogue(): void {
  doc.on(QueryCommand).resolves({ Items: [] });
  doc.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'TOOL#crm' } }).resolves({
    Items: [{ SK: 'TOOL#get_account' }, { SK: 'TOOL#list_cases' }, { SK: 'TOOL#update_case' }],
  });
  doc.on(QueryCommand, { ExpressionAttributeValues: { ':pk': 'TOOL#invoices' } }).resolves({ Items: [{ SK: 'TOOL#get_invoice' }, { SK: 'TOOL#list_invoices' }] });
  doc.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: { PK: string }[] }> }) => ({
    Responses: {
      [TABLE]: input.RequestItems[TABLE].Keys.filter((k) => ['NAME#default', 'NAME#billing'].includes(k.PK)).map((k) => ({ ...k, kind: 'agent' })),
    },
  }));
}

/** The tenant row as the handler reads it: first the plan alone (ProjectionExpression), then the whole row. */
function tenantReads(plan: string | undefined, after: Record<string, unknown>): void {
  doc.on(GetCommand).callsFake((input: { ProjectionExpression?: string }) =>
    input.ProjectionExpression === '#p' ? (plan === undefined ? {} : { Item: { plan } }) : { Item: after },
  );
}

function canceled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({ message: 'canceled', $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
}

function transactItems(): unknown[] {
  const calls = doc.commandCalls(TransactWriteCommand);
  return (calls[calls.length - 1].args[0].input.TransactItems ?? []) as unknown[];
}

beforeEach(() => {
  doc.reset();
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => jest.restoreAllMocks());

describe('PutTenantSubscription keeps the plan member index in the same transaction', () => {
  it('a new plan: tenant update conditioned on no plan, a ConditionCheck on the plan row, the member row put', async () => {
    catalogue();
    tenantReads(undefined, { ...tenantKey('tenant-a'), agents: [], tools: [], plan: 'standard', version: 1 });
    doc.on(TransactWriteCommand).resolves({});
    const out = await service().PutTenantSubscription({ tenantId: 'tenant-a', agents: [], tools: [], plan: 'standard' }, vendor);
    expect(out.subscription.plan).toBe('standard');
    const items = transactItems() as Record<string, any>[];
    expect(items[0].Update.ConditionExpression).toBe('attribute_not_exists(#p)');
    expect(items[1]).toEqual({ ConditionCheck: { TableName: TABLE, Key: planKey('standard'), ConditionExpression: 'attribute_exists(PK)' } });
    expect(items[2].Put.Item).toMatchObject(planMemberKey('standard', 'tenant-a'));
    expect(items).toHaveLength(3);
    expect(doc).toHaveReceivedCommandTimes(ScanCommand, 0);
  });

  it('a plan change moves the member row; dropping the plan deletes it', async () => {
    catalogue();
    tenantReads('standard', { agents: ['default'], tools: ['crm/*'], version: 2 });
    doc.on(TransactWriteCommand).resolves({});
    await service().PutTenantSubscription({ tenantId: 'tenant-a', agents: ['default'], tools: ['crm/*'], plan: 'gold' }, vendor);
    let items = transactItems() as Record<string, any>[];
    expect(items[0].Update.ConditionExpression).toBe('#p = :old');
    expect(items[0].Update.ExpressionAttributeValues[':old']).toBe('standard');
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Update', 'ConditionCheck', 'Put', 'Delete']);
    expect(items[3].Delete.Key).toEqual(planMemberKey('standard', 'tenant-a'));

    await service().PutTenantSubscription({ tenantId: 'tenant-a', agents: ['default'], tools: ['crm/*'] }, vendor);
    items = transactItems() as Record<string, any>[];
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Update', 'Delete']);
    expect(items[0].Update.UpdateExpression).toContain('REMOVE #p');
  });

  it('the same plan again writes no member row', async () => {
    catalogue();
    tenantReads('standard', { plan: 'standard' });
    doc.on(TransactWriteCommand).resolves({});
    await service().PutTenantSubscription({ tenantId: 'tenant-a', plan: 'standard' }, vendor);
    expect((transactItems() as Record<string, unknown>[]).map((i) => Object.keys(i)[0])).toEqual(['Update', 'ConditionCheck']);
  });

  it('an unknown plan is 400 unknown_name; a lost race on the row is 409 concurrent_write', async () => {
    catalogue();
    doc.on(GetCommand).resolves({});
    doc.on(TransactWriteCommand).rejectsOnce(canceled(['None', 'ConditionalCheckFailed', 'None'])).rejectsOnce(canceled(['ConditionalCheckFailed', 'None', 'None']));
    await expect(service().PutTenantSubscription({ tenantId: 'tenant-a', plan: 'nosuch' }, vendor)).rejects.toMatchObject({ name: 'ValidationError', reason: 'unknown_name' });
    await expect(service().PutTenantSubscription({ tenantId: 'tenant-a', plan: 'standard' }, vendor)).rejects.toMatchObject({ name: 'ConflictError', reason: 'concurrent_write' });
  });

  it('a name outside the reservations or the catalogue is 400 unknown_name', async () => {
    catalogue();
    await expect(service().PutTenantSubscription({ tenantId: 'tenant-a', agents: ['nosuch'] }, vendor)).rejects.toMatchObject({ reason: 'unknown_name' });
    await expect(service().PutTenantSubscription({ tenantId: 'tenant-a', tools: ['crm/nosuch'] }, vendor)).rejects.toMatchObject({ reason: 'unknown_name' });
    expect(doc).toHaveReceivedCommandTimes(TransactWriteCommand, 0);
  });

  it('the tenant-admin door may not write a subscription', async () => {
    await expect(service().PutTenantSubscription({ tenantId: 'tenant-a' }, admin)).rejects.toMatchObject({ name: 'ForbiddenError', reason: 'vendor_only' });
  });
});

describe('plans without a Scan', () => {
  it('PutPlan writes the plan row and its PLANS listing row in one transaction', async () => {
    catalogue();
    doc.on(TransactWriteCommand).resolves({});
    doc.on(GetCommand).resolves({ Item: { agents: ['default', 'billing'], tools: ['crm/*', 'invoices/*'], version: 1, updatedAt: NOW.toISOString() } });
    const out = await service().PutPlan({ planName: 'standard', agents: ['default', 'billing'], tools: ['crm/*', 'invoices/*'] }, vendor);
    expect(out.plan).toMatchObject({ planName: 'standard', agents: ['default', 'billing'], version: 1 });
    const items = transactItems() as Record<string, any>[];
    expect(items[0].Update.Key).toEqual(planKey('standard'));
    expect(items[1].Put.Item).toMatchObject(planIndexKey('standard'));
  });

  it('ListPlans Queries the PLANS partition and batch-reads the rows; nextToken stays in that partition', async () => {
    doc.on(QueryCommand).resolves({ Items: [{ SK: 'PLAN#gold' }, { SK: 'PLAN#standard' }], LastEvaluatedKey: { PK: 'PLANS', SK: 'PLAN#standard' } });
    doc.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [{ ...planKey('standard'), agents: ['default'], tools: [], version: 3 }, { ...planKey('gold'), agents: [], tools: [], version: 1 }] } });
    const out = await service().ListPlans({}, vendor);
    expect(out.plans.map((p) => p.planName)).toEqual(['gold', 'standard']);
    expect(doc).toHaveReceivedCommandWith(QueryCommand, { ExpressionAttributeValues: { ':pk': 'PLANS' } });
    expect(decodeToken(out.nextToken, 'PLANS')).toEqual({ PK: 'PLANS', SK: 'PLAN#standard' });
    await expect(service().ListPlans({ nextToken: encodeToken({ PK: 'TENANT#b', SK: '#SUB' }) }, vendor)).rejects.toMatchObject({ reason: 'invalid_input' });
    expect(doc).toHaveReceivedCommandTimes(ScanCommand, 0);
  });

  it('ListPlans of no plans is no batch read', async () => {
    doc.on(QueryCommand).resolves({ Items: [] });
    expect((await service().ListPlans({}, vendor)).plans).toEqual([]);
    expect(doc).toHaveReceivedCommandTimes(BatchGetCommand, 0);
  });

  it('DeletePlan is 409 plan_in_use while a member row exists, else deletes the plan and its listing row', async () => {
    doc.on(QueryCommand).resolvesOnce({ Items: [{ SK: 'TENANT#tenant-a' }] }).resolvesOnce({ Items: [] });
    doc.on(TransactWriteCommand).resolves({});
    await expect(service().DeletePlan({ planName: 'standard' }, vendor)).rejects.toMatchObject({ name: 'ConflictError', reason: 'plan_in_use' });
    expect(doc).toHaveReceivedCommandWith(QueryCommand, {
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :tenant)',
      ExpressionAttributeValues: { ':pk': 'PLAN#standard', ':tenant': 'TENANT#' },
      Limit: 1,
    });
    await service().DeletePlan({ planName: 'standard' }, vendor);
    expect(transactItems()).toEqual([
      { Delete: { TableName: TABLE, Key: planKey('standard') } },
      { Delete: { TableName: TABLE, Key: planIndexKey('standard') } },
    ]);
    expect(doc).toHaveReceivedCommandTimes(ScanCommand, 0);
  });
});

describe('DeleteTenantSubscription', () => {
  it('deletes the tenant row, its cut rows and its plan member row, resending throttled deletes', async () => {
    doc.on(QueryCommand).resolves({ Items: [{ ...tenantKey('tenant-a'), plan: 'standard' }, { PK: 'TENANT#tenant-a', SK: 'USER#u1' }] });
    doc.on(BatchWriteCommand).resolvesOnce({ UnprocessedItems: { [TABLE]: [{ DeleteRequest: { Key: { PK: 'TENANT#tenant-a', SK: 'USER#u1' } } }] } }).resolvesOnce({});
    await service().DeleteTenantSubscription({ tenantId: 'tenant-a' }, vendor);
    const first = doc.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems![TABLE].map((r) => r.DeleteRequest!.Key);
    expect(first).toEqual([tenantKey('tenant-a'), { PK: 'TENANT#tenant-a', SK: 'USER#u1' }, planMemberKey('standard', 'tenant-a')]);
    expect(doc).toHaveReceivedCommandTimes(BatchWriteCommand, 2);
  });

  it('writes still unprocessed after the retries are a 502', async () => {
    doc.on(QueryCommand).resolves({ Items: [tenantKey('tenant-a')] });
    doc.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE]: [{ DeleteRequest: { Key: tenantKey('tenant-a') } }] } });
    await expect(service().DeleteTenantSubscription({ tenantId: 'tenant-a' }, vendor)).rejects.toMatchObject({ name: 'UpstreamError' });
  });
});

describe('a cut names only what the tenant holds (ADR-0033)', () => {
  const plan = { agents: ['default', 'billing'], tools: ['crm/*', 'invoices/*'] };

  function tenantOnPlan(direct: { agents?: string[]; tools?: string[] } = {}): void {
    catalogue();
    doc.on(GetCommand, { Key: tenantKey('tenant-a') }).resolves({ Item: { ...tenantKey('tenant-a'), plan: 'standard', version: 4, ...direct } });
    doc.on(GetCommand, { Key: planKey('standard') }).resolves({ Item: plan });
  }

  it('an agent, a tool and a whole target the tenant holds through its plan are accepted', async () => {
    tenantOnPlan();
    await expect(service().validateCut('tenant-a', client, ['billing'], ['crm/update_case', 'invoices/*'])).resolves.toBe(4);
  });

  it('an agent or a tool the tenant does not hold is 400 not_subscribed', async () => {
    catalogue();
    doc.on(GetCommand, { Key: tenantKey('tenant-b') }).resolves({ Item: { agents: ['default'], tools: ['crm/get_account', 'crm/list_cases'] } });
    await expect(service().validateCut('tenant-b', client, ['billing'], [])).rejects.toMatchObject({ reason: 'not_subscribed' });
    await expect(service().validateCut('tenant-b', client, [], ['crm/update_case'])).rejects.toMatchObject({ reason: 'not_subscribed' });
    await expect(service().validateCut('tenant-b', client, [], ['invoices/get_invoice'])).rejects.toMatchObject({ reason: 'not_subscribed' });
    // crm/* names update_case, which tenant B does not hold.
    await expect(service().validateCut('tenant-b', client, [], ['crm/*'])).rejects.toMatchObject({ reason: 'not_subscribed' });
    // Held tools are fine.
    await expect(service().validateCut('tenant-b', client, [], ['crm/get_account'])).resolves.toBe(0);
  });

  it('a name outside the catalogue is not_subscribed, never a silent no-op', async () => {
    tenantOnPlan();
    await expect(service().validateCut('tenant-a', client, [], ['crm/nosuch'])).rejects.toMatchObject({ reason: 'not_subscribed' });
    await expect(service().validateCut('tenant-a', client, [], ['nosuch/*'])).rejects.toMatchObject({ reason: 'not_subscribed' });
  });

  it('a tenant with no row is 404; a cut over the bound is 400 too_many', async () => {
    doc.on(GetCommand).resolves({});
    await expect(service().validateCut('tenant-x', client, [], [])).rejects.toMatchObject({ name: 'ResourceNotFoundError' });
    await expect(service({ maxToolsPerTenant: 1 }).validateCut('tenant-a', client, [], ['crm/a', 'crm/b'])).rejects.toMatchObject({ reason: 'too_many' });
  });

  it('PutUserCut refuses a cut of something not held before any write', async () => {
    tenantOnPlan();
    await expect(service().PutUserCut({ sub: 'u1', cutTools: ['crm/nosuch'] }, admin)).rejects.toMatchObject({ reason: 'not_subscribed' });
    expect(doc).toHaveReceivedCommandTimes(TransactWriteCommand, 0);
  });

  it('ListUserCuts refuses a nextToken from another tenant partition', async () => {
    await expect(service().ListUserCuts({ nextToken: encodeToken({ PK: 'TENANT#tenant-b', SK: 'USER#x' }) }, admin)).rejects.toMatchObject({ reason: 'invalid_input' });
  });
});
