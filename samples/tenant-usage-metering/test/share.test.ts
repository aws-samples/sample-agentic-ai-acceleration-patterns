// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { App, Stack, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { TenantUsageMeteringProps } from '../src/construct/props';
import { offendingEmitters } from '../src/guard/share-guard';
import { handler } from '../src/guard/share-guard.function';
import { TenantUsageMetering } from '../src/tenant-usage-metering';

const ACCOUNT = '111122223333';
const VENDOR_A = '444455556666';
const VENDOR_B = '777788889999';
const base: TenantUsageMeteringProps = {
  fleetName: 'demo',
  registrarPrincipalArns: [`arn:aws:iam::${ACCOUNT}:role/demo-global-hook`],
  operatorPrincipalArns: [`arn:aws:iam::${ACCOUNT}:role/metering-operator`],
};

function build(props: Partial<TenantUsageMeteringProps> = {}, nag = false): { app: App; stack: Stack } {
  // No asset bundling in unit tests: the functions' code is not under test here.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  if (nag) {
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  }
  const stack = new Stack(app, 'Test', { env: { account: ACCOUNT, region: 'eu-central-1' } });
  new TenantUsageMetering(stack, 'Metering', { ...base, ...props });
  return { app, stack };
}

const synth = (props: Partial<TenantUsageMeteringProps> = {}): Template => Template.fromStack(build(props).stack);

type Share = { Properties: Record<string, unknown>; DependsOn?: string[] };
const sharesOf = (template: Template): Share[] => Object.values(template.findResources('AWS::RAM::ResourceShare')) as Share[];
const permission = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ram::aws:permission/AWSRAMEventBridgeEventBusV2SubscribeOnly']] };

describe('bus sharing through AWS RAM (spec §3.2, ADR-0006, M-6)', () => {
  test('no list: no share, no guard, no guard function', () => {
    const template = synth();
    expect(sharesOf(template)).toHaveLength(0);
    template.resourceCountIs('Custom::BusShareGuard', 0);
    const functions = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(functions.filter((id) => id.includes('BusShareGuard'))).toEqual([]);
  });

  test('each listed bus is shared SubscribeOnly with its accounts, after the guard', () => {
    const template = synth({ rawSubscriberAccountIds: [VENDOR_A], usageSubscriberAccountIds: [VENDOR_B, VENDOR_B] });
    const shares = sharesOf(template);
    expect(shares).toHaveLength(2);
    const guardId = Object.keys(template.findResources('Custom::BusShareGuard'))[0];
    const busId = (share: Share) => ((share.Properties.ResourceArns as Array<{ 'Fn::GetAtt': [string, string] }>)[0])['Fn::GetAtt'][0];
    const ingest = shares.find((share) => busId(share).startsWith('MeteringIngestBus'))!;
    const usage = shares.find((share) => busId(share).startsWith('MeteringUsageBus'))!;
    expect(ingest.Properties).toMatchObject({ Principals: [VENDOR_A], PermissionArns: [permission], AllowExternalPrincipals: true });
    expect(ingest.Properties.Name).toMatch(/-ingest-share$/);
    expect(usage.Properties).toMatchObject({ Principals: [VENDOR_B], PermissionArns: [permission], AllowExternalPrincipals: true });
    expect(usage.Properties.Name).toMatch(/-usage-share$/);
    for (const share of shares) {
      expect(share.DependsOn).toContain(guardId);
    }
    // The guard checks the union of both lists.
    template.hasResourceProperties('Custom::BusShareGuard', { AccountIds: [VENDOR_A, VENDOR_B] });
  });

  test('only the usage bus is shared on DIRECT, which has no ingest bus', () => {
    const template = synth({ ingestPath: 'DIRECT', usageSubscriberAccountIds: [VENDOR_B] });
    const shares = sharesOf(template);
    expect(shares).toHaveLength(1);
    expect(shares[0].Properties.Principals).toEqual([VENDOR_B]);
  });

  test('a raw subscriber list on DIRECT fails synth', () => {
    expect(() => synth({ ingestPath: 'DIRECT', rawSubscriberAccountIds: [VENDOR_A] })).toThrow(/rawSubscriberAccountIds needs ingestPath BUS/);
  });

  test.each(['rawSubscriberAccountIds', 'usageSubscriberAccountIds'] as const)('the metering account in %s fails synth', (list) => {
    expect(() => synth({ [list]: [ACCOUNT] })).toThrow(new RegExp(`${list} holds the metering account ${ACCOUNT}`));
  });

  test('an unresolved stack account skips the metering-account check', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Agnostic');
    expect(() => new TenantUsageMetering(stack, 'Metering', { ...base, usageSubscriberAccountIds: [ACCOUNT] })).not.toThrow();
  });

  test('the guard runs after the admin function, so the block list is live before the registry is read', () => {
    const template = synth({ usageSubscriberAccountIds: [VENDOR_B] });
    const guard = Object.values(template.findResources('Custom::BusShareGuard'))[0] as { DependsOn?: string[] };
    const adminFn = Object.keys(template.findResources('AWS::Lambda::Function')).find((id) => id.startsWith('MeteringAdminFunction'));
    expect(adminFn).toBeDefined();
    expect(guard.DependsOn).toContain(adminFn);
  });

  test('an empty usage list leaves the usage bus unshared', () => {
    const shares = sharesOf(synth({ rawSubscriberAccountIds: [VENDOR_A] }));
    expect(shares).toHaveLength(1);
    expect(shares[0].Properties.Principals).toEqual([VENDOR_A]);
  });

  test('the guard role may only Query the list-by-type index', () => {
    const template = synth({ usageSubscriberAccountIds: [VENDOR_B] });
    const policies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('MeteringBusShareGuardRole'));
    expect(policies).toHaveLength(1);
    const statements = (policies[0][1].Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>).filter(
      (s) => JSON.stringify(s.Action).includes('dynamodb'),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('dynamodb:Query');
    expect(JSON.stringify(statements[0].Resource)).toContain('/index/list-by-type');
  });

  test('cdk-nag passes with both shares and the guard', () => {
    const { app } = build({ rawSubscriberAccountIds: [VENDOR_A], usageSubscriberAccountIds: [VENDOR_B] }, true);
    expect(() => app.synth()).not.toThrow();
  });

  test('the dispatcher role is published', () => {
    const { stack } = build();
    const metering = stack.node.findChild('Metering') as TenantUsageMetering;
    expect(metering.dispatcherRole).toBe(metering.roles.dispatcher);
  });
});

describe('bus share guard (ADR-0006)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const NOW = Date.parse('2026-11-19T12:00:00Z');
  const emitter = (accountId: string, cellId: string, closesAt?: string) => ({
    accountId,
    cellId,
    status: closesAt === undefined ? 'ACTIVE' : 'CLOSING',
    ...(closesAt !== undefined ? { closesAt } : {}),
  });
  const event = (RequestType: 'Create' | 'Update' | 'Delete', AccountIds: string[]): CloudFormationCustomResourceEvent =>
    ({
      RequestType,
      ServiceToken: 'x',
      ResponseURL: 'x',
      StackId: 'x',
      RequestId: 'x',
      LogicalResourceId: 'BusShareGuard',
      ResourceType: 'Custom::BusShareGuard',
      ...(RequestType === 'Create' ? {} : { PhysicalResourceId: 'bus-share-guard' }),
      ResourceProperties: { ServiceToken: 'x', AccountIds },
    }) as CloudFormationCustomResourceEvent;

  beforeEach(() => {
    ddb.reset();
    process.env.METERING_TABLE_NAME = 'table';
  });

  test('reads every page of the emitter list through the index, projected', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [emitter(VENDOR_A, 'C1')], LastEvaluatedKey: { PK: 'x' } })
      .resolvesOnce({ Items: [emitter(ACCOUNT, 'C2'), emitter(VENDOR_B, 'C3')] });
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    expect(await offendingEmitters(db, 'table', [VENDOR_A, VENDOR_B], NOW)).toEqual([
      { accountId: VENDOR_A, cellId: 'C1', status: 'ACTIVE' },
      { accountId: VENDOR_B, cellId: 'C3', status: 'ACTIVE' },
    ]);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input).toMatchObject({
      IndexName: 'list-by-type',
      ExpressionAttributeValues: { ':t': 'EMITTER' },
      ExpressionAttributeNames: { '#status': 'status' },
      ProjectionExpression: 'accountId, cellId, #status, closesAt',
    });
  });

  test('a CLOSING emitter counts before its closesAt and not after', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [emitter(VENDOR_A, 'C1', new Date(NOW + 60_000).toISOString()), emitter(VENDOR_A, 'C2', new Date(NOW - 60_000).toISOString())],
    });
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    const closesAt = new Date(NOW + 60_000).toISOString();
    expect(await offendingEmitters(db, 'table', [VENDOR_A], NOW)).toEqual([{ accountId: VENDOR_A, cellId: 'C1', status: 'CLOSING', closesAt }]);
  });

  test('a CLOSING emitter with no closesAt counts', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ accountId: VENDOR_A, cellId: 'C1', status: 'CLOSING' }] });
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    expect(await offendingEmitters(db, 'table', [VENDOR_A], NOW)).toEqual([{ accountId: VENDOR_A, cellId: 'C1', status: 'CLOSING' }]);
  });

  test('a CLOSING emitter with an unreadable closesAt counts', async () => {
    ddb.on(QueryCommand).resolves({ Items: [emitter(VENDOR_A, 'C1', 'not-a-date')] });
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
    expect(await offendingEmitters(db, 'table', [VENDOR_A], NOW)).toEqual([
      { accountId: VENDOR_A, cellId: 'C1', status: 'CLOSING', closesAt: 'not-a-date' },
    ]);
  });

  test.each(['Create', 'Update'] as const)('%s fails when a listed account holds a cell, naming the account, the cell and its state', async (type) => {
    ddb.on(QueryCommand).resolves({ Items: [emitter(VENDOR_A, '01JD00000000000000000000C1')] });
    await expect(handler(event(type, [VENDOR_A]))).rejects.toThrow(`account ${VENDOR_A} (cell 01JD00000000000000000000C1, ACTIVE)`);
  });

  test('the refusal gives a closing cell its close time', async () => {
    // The handler reads the wall clock, so the close time is far ahead of it.
    const closesAt = '2999-01-01T00:00:00.000Z';
    ddb.on(QueryCommand).resolves({ Items: [emitter(VENDOR_A, 'C1', closesAt)] });
    await expect(handler(event('Create', [VENDOR_A]))).rejects.toThrow(`(cell C1, CLOSING until ${closesAt})`);
  });

  test.each(['Create', 'Update'] as const)('%s succeeds when no listed account holds a cell', async (type) => {
    ddb.on(QueryCommand).resolves({ Items: [emitter(ACCOUNT, 'C2')] });
    await expect(handler(event(type, [VENDOR_A]))).resolves.toEqual({ PhysicalResourceId: 'bus-share-guard' });
  });

  test('Delete reads nothing and succeeds', async () => {
    ddb.on(QueryCommand).resolves({ Items: [emitter(VENDOR_A, 'C1')] });
    await expect(handler(event('Delete', [VENDOR_A]))).resolves.toEqual({ PhysicalResourceId: 'bus-share-guard' });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
