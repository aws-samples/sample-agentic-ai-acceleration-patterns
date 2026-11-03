// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import type { VendedCredentials } from '../../src/shared/tvm';
import type { ToolContext, ToolInvocation } from '../../src/tools/context';
import { CRM_TOOLS, crmWith } from '../../src/tools/demo/crm.function';
import { type DemoDataDependencies, defaultDemoData, DEMO_TOOL_ENV } from '../../src/tools/demo/data';
import { INVOICES_TOOLS, invoicesWith } from '../../src/tools/demo/invoices.function';

/** The demo tools read tenant data only with the tool TVM's credentials, keyed by the context's tenant (P-15). */
const doc = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const CREDENTIALS: VendedCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example', sessionToken: 'example', expiration: '2030-01-01T00:00:00Z' };

function invocation(tool: string, args: Record<string, unknown> = {}, credentials: VendedCredentials | null = CREDENTIALS): ToolInvocation {
  const context: ToolContext = { tenantId: 'tenant-a', sub: 'tenant-a#u1', user: 'u1', agent: 'default', tool, txn: 'txn-1', exp: 2_000_000_000 };
  return { context, args, credentials: credentials ?? undefined };
}

let used: VendedCredentials[];
function deps(overrides: Partial<DemoDataDependencies> = {}): DemoDataDependencies {
  return {
    tableName: 'DemoTable',
    client: (credentials) => {
      used.push(credentials);
      return client;
    },
    testMode: false,
    ...overrides,
  };
}

beforeEach(() => {
  doc.reset();
  used = [];
});

describe('crm', () => {
  it('get_account reads TENANT#<context tenant> with the vended credentials, never the argument tenant', async () => {
    doc.on(GetCommand).resolves({ Item: { crmAccount: { accountId: 'acc-a', name: 'Tenant A account' } } });
    const out = await crmWith(deps())(invocation('crm/get_account', { tenantId: 'tenant-a' }));
    expect(out).toMatchObject({ tenantId: 'tenant-a', account: { accountId: 'acc-a' }, source: 'table', contextVerified: true, argsTenantId: 'tenant-a' });
    expect(doc).toHaveReceivedCommandWith(GetCommand, { TableName: 'DemoTable', Key: { PK: 'TENANT#tenant-a' }, ExpressionAttributeNames: { '#a': 'crmAccount' } });
    expect(used).toEqual([CREDENTIALS]);
    expect(out.contextClaims).toEqual(['agent', 'exp', 'sub', 'tenantId', 'tool', 'txn', 'user']);
  });

  it('list_cases lists the tenant item\'s cases, sorted', async () => {
    doc.on(GetCommand).resolves({ Item: { crmCases: { 'case-2': { status: 'closed' }, 'case-1': { status: 'open' } } } });
    expect((await crmWith(deps())(invocation('crm/list_cases'))).cases).toEqual([
      { caseId: 'case-1', status: 'open' },
      { caseId: 'case-2', status: 'closed' },
    ]);
  });

  it('update_case writes one case of the tenant item, conditioned on the case existing', async () => {
    doc.on(UpdateCommand).resolves({});
    const out = await crmWith(deps())(invocation('crm/update_case', { caseId: 'case-1', status: 'closed' }));
    expect(out).toMatchObject({ caseId: 'case-1', status: 'closed', updated: true });
    expect(doc).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: 'TENANT#tenant-a' },
      UpdateExpression: 'SET #m.#k.#f = :v',
      ConditionExpression: 'attribute_exists(#m.#k)',
      ExpressionAttributeNames: { '#m': 'crmCases', '#k': 'case-1', '#f': 'status' },
    });
  });

  it('update_case of an unknown case is updated: false; a bad case id writes nothing', async () => {
    doc.on(UpdateCommand).rejects(Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' }));
    expect((await crmWith(deps())(invocation('crm/update_case', { caseId: 'nosuch' }))).updated).toBe(false);
    doc.reset();
    expect((await crmWith(deps())(invocation('crm/update_case', { caseId: 'a b' }))).error).toBe('invalid_arguments');
    expect(doc).toHaveReceivedCommandTimes(UpdateCommand, 0);
  });

  it('test mode: probeTenantId reads another tenant with the SAME credentials and reports only the error name (integ step 20)', async () => {
    const denied = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
    doc.on(GetCommand, { Key: { PK: 'TENANT#tenant-b' } }).rejects(denied);
    doc.on(GetCommand, { Key: { PK: 'TENANT#tenant-a' } }).resolves({ Item: { crmAccount: { accountId: 'acc-a' } } });
    const out = await crmWith(deps({ testMode: true }))(invocation('crm/get_account', { probeTenantId: 'tenant-b' }));
    expect(out.probe).toEqual({ tenant: 'tenant-b', result: 'error', error: 'AccessDeniedException' });
    expect(JSON.stringify(out)).not.toContain('not authorized');
    expect(used.every((c) => c === CREDENTIALS)).toBe(true);
  });

  it('without test mode probeTenantId does nothing', async () => {
    doc.on(GetCommand).resolves({ Item: {} });
    const out = await crmWith(deps())(invocation('crm/get_account', { probeTenantId: 'tenant-b' }));
    expect(out.probe).toBeUndefined();
    expect(doc).toHaveReceivedCommandTimes(GetCommand, 1);
  });

  it('without a table or credentials answers synthetic data and calls nothing', async () => {
    expect((await crmWith(deps({ tableName: undefined }))(invocation('crm/get_account'))).source).toBe('synthetic');
    expect((await crmWith(deps())(invocation('crm/list_cases', {}, null))).source).toBe('synthetic');
    expect(doc).toHaveReceivedCommandTimes(GetCommand, 0);
  });

  it('serves the three tools of spec §8', () => {
    expect(CRM_TOOLS.map((t) => t.name)).toEqual(['get_account', 'list_cases', 'update_case']);
  });
});

describe('invoices', () => {
  it('get_invoice and list_invoices read the tenant item\'s invoices with the vended credentials', async () => {
    doc.on(GetCommand).resolves({ Item: { invoices: { 'inv-2': { amount: '20.00', currency: 'EUR' }, 'inv-1': { amount: '10.00', currency: 'EUR' } } } });
    expect((await invoicesWith(deps())(invocation('invoices/get_invoice', { invoiceId: 'inv-1' }))).invoice).toEqual({ invoiceId: 'inv-1', amount: '10.00', currency: 'EUR' });
    expect((await invoicesWith(deps())(invocation('invoices/get_invoice', { invoiceId: 'nosuch' }))).invoice).toBeNull();
    expect(((await invoicesWith(deps())(invocation('invoices/list_invoices'))).invoices as { invoiceId: string }[]).map((i) => i.invoiceId)).toEqual(['inv-1', 'inv-2']);
    expect(doc).toHaveReceivedCommandWith(GetCommand, { Key: { PK: 'TENANT#tenant-a' }, ExpressionAttributeNames: { '#a': 'invoices' } });
  });

  it('serves two tools (ADR-0041: a partial grant for the finance list filter)', async () => {
    expect(INVOICES_TOOLS.map((t) => t.name)).toEqual(['get_invoice', 'list_invoices']);
    expect((await invoicesWith(deps())(invocation('invoices/void_invoice'))).error).toBe('unknown_tool');
  });
});

describe('defaultDemoData', () => {
  it('reads the table and the test mode from the environment', () => {
    const d = defaultDemoData({ [DEMO_TOOL_ENV.TABLE_NAME]: 'T', [DEMO_TOOL_ENV.TEST_MODE]: 'true' });
    expect(d.tableName).toBe('T');
    expect(d.testMode).toBe(true);
    expect(defaultDemoData({}).tableName).toBeUndefined();
    expect(d.client(CREDENTIALS)).toBeDefined();
  });
});
