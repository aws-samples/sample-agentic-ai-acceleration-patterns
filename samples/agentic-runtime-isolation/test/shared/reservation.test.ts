// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { gatewayTargetKey, toolKey } from '../../src/shared/entitlements';
import { gatewayLimitProblem, handleEvent, type OwnedRow, type ReservationEvent } from '../../src/shared/reservation.function';

/** The owner-marked rows custom resource (ADR-0035) and its deploy-time gateway bound (ADR-0040, ADR-0041). */
const doc = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const TABLE = 'Entitlements';

function event(type: ReservationEvent['RequestType'], rows: ReservationEvent['ResourceProperties']['Rows'], extra: Partial<ReservationEvent['ResourceProperties']> = {}, old?: ReservationEvent['ResourceProperties']): ReservationEvent {
  return {
    RequestType: type,
    ResponseURL: 'https://example.com',
    StackId: 'stack-1',
    RequestId: 'r',
    LogicalResourceId: 'Catalogue',
    PhysicalResourceId: type === 'Create' ? undefined : 'reservation:NAME#crm',
    ResourceProperties: { TableName: TABLE, Rows: rows, ...extra },
    OldResourceProperties: old,
  };
}

const limit = { Gateway: 'default', Target: 'crm', Tools: '3', MaxTools: '300', MaxTargets: '100' };
const crmRows: OwnedRow[] = [
  { ...toolKey('crm', 'get_account'), attributes: { description: 'd', gateway: 'default' } },
  { ...gatewayTargetKey('default', 'crm'), attributes: { tools: '3' } },
];

beforeEach(() => {
  doc.reset();
  doc.on(PutCommand).resolves({});
  doc.on(DeleteCommand).resolves({});
});

describe('gateway bound at deploy (ADR-0040, ADR-0041)', () => {
  it('counts every other target of the gateway, from any stack, and admits within the bounds', async () => {
    doc.on(QueryCommand).resolves({ Items: [{ SK: 'TARGET#crm', tools: '3' }, { SK: 'TARGET#other', tools: '200' }] });
    expect(await gatewayLimitProblem(client, TABLE, limit)).toBeUndefined();
    expect(doc).toHaveReceivedCommandWith(QueryCommand, { ExpressionAttributeValues: { ':pk': 'GATEWAY#default' }, ConsistentRead: true });
  });

  it('fails the deploy with a clear message past maxToolsPerGateway, before any row is written', async () => {
    doc.on(QueryCommand).resolves({ Items: [{ SK: 'TARGET#other', tools: '298' }] });
    const outcome = await handleEvent(event('Create', crmRows, { GatewayLimit: limit }), client);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toBe(
      "target 'crm' would bring tools gateway 'default' to 301 catalogued tools, over maxToolsPerGateway 300 (ADR-0041); put the target on another tools gateway",
    );
    expect(doc).toHaveReceivedCommandTimes(PutCommand, 0);
  });

  it('fails the deploy at the 101st target', async () => {
    doc.on(QueryCommand).resolves({ Items: Array.from({ length: 100 }, (_, i) => ({ SK: `TARGET#t${i}`, tools: '1' })) });
    const outcome = await handleEvent(event('Create', crmRows, { GatewayLimit: limit }), client);
    expect(outcome.reason).toMatch(/tools gateway 'default' holds at most 100 tool targets; target 'crm' would be number 101 \(ADR-0040\)/);
  });

  it('follows the Query pages', async () => {
    doc.on(QueryCommand).resolvesOnce({ Items: [{ SK: 'TARGET#a', tools: '150' }], LastEvaluatedKey: { PK: 'GATEWAY#default', SK: 'TARGET#a' } }).resolvesOnce({ Items: [{ SK: 'TARGET#b', tools: '150' }] });
    expect(await gatewayLimitProblem(client, TABLE, limit)).toMatch(/303 catalogued tools/);
  });

  it('refuses malformed numbers', async () => {
    expect(await gatewayLimitProblem(client, TABLE, { ...limit, MaxTools: 'x' })).toBe('GatewayLimit must carry whole numbers');
  });
});

describe('catalogue rows carry the gateway', () => {
  it('an Update re-puts every row with its gateway attribute (rows from before ADR-0041 gain it), and releases rows it dropped', async () => {
    doc.on(QueryCommand).resolves({ Items: [] });
    const old = { TableName: TABLE, Rows: [{ ...toolKey('crm', 'get_account'), attributes: { description: 'd' } }, { ...toolKey('crm', 'gone'), attributes: { description: 'g' } }] };
    const outcome = await handleEvent(event('Update', crmRows, { GatewayLimit: limit }, old), client);
    expect(outcome.status).toBe('SUCCESS');
    expect(doc).toHaveReceivedCommandWith(PutCommand, { Item: expect.objectContaining({ ...toolKey('crm', 'get_account'), gateway: 'default', owner: 'stack-1#Catalogue' }) });
    expect(doc).toHaveReceivedCommandWith(PutCommand, { Item: expect.objectContaining({ ...gatewayTargetKey('default', 'crm'), tools: '3' }) });
    expect(doc).toHaveReceivedCommandWith(DeleteCommand, { Key: toolKey('crm', 'gone') });
  });

  it('Delete releases the count row with the rest and runs no gateway check', async () => {
    const outcome = await handleEvent(event('Delete', crmRows, { GatewayLimit: limit }), client);
    expect(outcome.status).toBe('SUCCESS');
    expect(doc).toHaveReceivedCommandWith(DeleteCommand, { Key: gatewayTargetKey('default', 'crm') });
    expect(doc).toHaveReceivedCommandTimes(QueryCommand, 0);
  });
});
