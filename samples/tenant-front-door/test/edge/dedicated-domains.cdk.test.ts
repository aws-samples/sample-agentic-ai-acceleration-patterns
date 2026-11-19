// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Template } from 'aws-cdk-lib/assertions';
import { BASE_PROPS, EDGE_ACCOUNT, FULL_HOST_PROPS, only, synth } from './helpers';
import { REGISTRAR_DRAIN_MS } from '../../src/custom-resources/dedicated-domains-guard.function';
import { REGISTRAR_TIMEOUT } from '../../src/edge/main.cdk';
import { REGISTRAR_ENV, SWEEPER_ENV, SWEEPER_METRIC_NAMESPACE, SWEEPER_METRICS, SWEEPER_RECHECK_INPUT, SWEEPER_REMOVE_INPUT, TAG_DISTRIBUTION_ID, TAG_TENANT_ID } from '../../src/shared/contracts';

const off = synth(BASE_PROPS);
const on = synth({ ...BASE_PROPS, dedicatedDomains: true });
const onHost = synth({ ...FULL_HOST_PROPS, dedicatedDomains: true });

const TOPIC = FULL_HOST_PROPS.alarmTopicArn;
const TENANT_ARNS = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:cloudfront::${EDGE_ACCOUNT}:distribution-tenant/*`]] };
const CERT_ARNS = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:acm:us-east-1:${EDGE_ACCOUNT}:certificate/*`]] };
const DISTRIBUTION = { Ref: 'Distribution' };
const DISTRIBUTION_TAG = { StringEquals: { [`aws:ResourceTag/${TAG_DISTRIBUTION_ID}`]: DISTRIBUTION } };
const TAGS_ON_CREATE = {
  'StringEquals': { [`aws:RequestTag/${TAG_DISTRIBUTION_ID}`]: DISTRIBUTION },
  'ForAllValues:StringEquals': { 'aws:TagKeys': [TAG_TENANT_ID, TAG_DISTRIBUTION_ID] },
};
const IN_US_EAST_1 = { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } };

type Resources = Record<string, { Type: string; Properties: Record<string, any>; DependsOn?: string[] }>;

function resources(t: Template): Resources {
  return t.toJSON().Resources;
}

/** The logical id of the one resource of a type whose id starts with `prefix`. */
function logicalId(t: Template, type: string, prefix: string): string {
  const ids = Object.entries(resources(t)).filter(([id, r]) => r.Type === type && id.startsWith(prefix)).map(([id]) => id);
  if (ids.length !== 1) throw new Error(`expected one ${type} ${prefix}*, found ${ids.length}`);
  return ids[0];
}

/** Every statement of every policy attached to the role whose logical id starts with `rolePrefix`. */
function statements(t: Template, rolePrefix: string): any[] {
  return Object.values(resources(t))
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref?.startsWith(rolePrefix)))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
}

function bySid(list: any[], sid: string): any {
  const s = list.find((x) => x.Sid === sid);
  if (s === undefined) throw new Error(`no statement ${sid}`);
  const { Effect, Sid, ...rest } = s;
  expect(Effect).toBe('Allow');
  return rest;
}

function actions(list: any[]): string[] {
  return list.flatMap((s) => [s.Action].flat());
}

function dependsOn(t: Template, id: string): string[] {
  return resources(t)[id].DependsOn ?? [];
}

function sweeperFunction(t: Template): Record<string, any> {
  return resources(t)[logicalId(t, 'AWS::Lambda::Function', 'SweeperFunction')].Properties;
}

describe('dedicatedDomains off (spec §3.6)', () => {
  it('deploys no sweeper, table, queue, schedule, starter or sweeper alarm', () => {
    for (const type of ['AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::Scheduler::Schedule', 'AWS::Lambda::EventInvokeConfig', 'Custom::TenantFrontDoorSweeperStarter']) {
      off.main.resourceCountIs(type, 0);
    }
    expect(Object.keys(resources(off.main)).filter((id) => id.startsWith('Sweeper'))).toEqual([]);
    off.main.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  });

  it('tells the registrar off and gives its role no CloudFront or ACM action', () => {
    const fn = resources(off.main)[logicalId(off.main, 'AWS::Lambda::Function', 'RegistrarFunction')].Properties;
    expect(fn.Environment.Variables[REGISTRAR_ENV.dedicatedDomains]).toBe('off');
    expect(actions(statements(off.main, 'RegistrarFunction')).filter((a) => /^(cloudfront|acm):/.test(a))).toEqual([]);
    expect(Object.keys(resources(off.main)).filter((id) => id.startsWith('RegistrarDedicatedDomainsPolicy'))).toEqual([]);
  });

  it('keeps the guard, with DedicatedDomains off, and the teardown', () => {
    expect(only(off.main, 'Custom::TenantFrontDoorDedicatedDomainsGuard')).toMatchObject({
      DedicatedDomains: 'off',
      DistributionId: DISTRIBUTION,
      PooledTenantId: { 'Fn::GetAtt': ['PooledTenant', 'Id'] },
      KeyValueStoreArn: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] },
    });
    expect(only(off.main, 'Custom::TenantFrontDoorDedicatedDomainsTeardown')).toMatchObject({ DistributionId: DISTRIBUTION });
    expect(actions(statements(off.main, 'DedicatedDomainsTeardownIsComplete'))).toContain('cloudfront:DeleteDistributionTenant');
  });
});

describe('dedicatedDomains on: registrar (spec §3.4)', () => {
  it('tells the registrar on, with the distribution id', () => {
    const fn = resources(on.main)[logicalId(on.main, 'AWS::Lambda::Function', 'RegistrarFunction')].Properties;
    expect(fn.Environment.Variables).toMatchObject({ [REGISTRAR_ENV.dedicatedDomains]: 'on', [REGISTRAR_ENV.distributionId]: DISTRIBUTION });
  });

  it('holds the CloudFront and ACM actions of a domain call in a policy of its own, writes conditioned on the registrar\'s tag', () => {
    const list = statements(on.main, 'RegistrarFunction');
    expect(bySid(list, 'DistributionTenantRead')).toEqual({
      Action: ['cloudfront:GetDistributionTenant', 'cloudfront:GetDistributionTenantByDomain'],
      Resource: TENANT_ARNS,
    });
    expect(bySid(list, 'DistributionTenantCreate')).toEqual({ Action: 'cloudfront:CreateDistributionTenant', Resource: '*', Condition: TAGS_ON_CREATE });
    expect(bySid(list, 'DistributionTenantTagOnCreate')).toEqual({ Action: 'cloudfront:TagResource', Resource: TENANT_ARNS, Condition: TAGS_ON_CREATE });
    expect(bySid(list, 'DistributionTenantUpdate')).toEqual({ Action: 'cloudfront:UpdateDistributionTenant', Resource: TENANT_ARNS, Condition: DISTRIBUTION_TAG });
    expect(bySid(list, 'CertificateList')).toEqual({ Action: 'acm:ListCertificates', Resource: '*', Condition: IN_US_EAST_1 });
    expect(bySid(list, 'CertificateRequest')).toEqual({
      Action: 'acm:RequestCertificate',
      Resource: '*',
      Condition: { ...TAGS_ON_CREATE, StringEquals: { ...TAGS_ON_CREATE.StringEquals, ...IN_US_EAST_1.StringEquals } },
    });
    expect(bySid(list, 'CertificateTagOnRequest')).toEqual({ Action: 'acm:AddTagsToCertificate', Resource: CERT_ARNS, Condition: TAGS_ON_CREATE });
    expect(bySid(list, 'CertificateRead')).toEqual({ Action: ['acm:DescribeCertificate', 'acm:ListTagsForCertificate'], Resource: CERT_ARNS });
  });

  it('never deletes a distribution tenant or a certificate, and has no access to the sweeper table', () => {
    const a = actions(statements(on.main, 'RegistrarFunction'));
    expect(a).not.toContain('cloudfront:DeleteDistributionTenant');
    expect(a).not.toContain('acm:DeleteCertificate');
    expect(a.filter((x) => x.startsWith('dynamodb:'))).toEqual([]);
  });

  it('creates the dedicated-domain policy before the function, so the switch never serves customDomain without it', () => {
    const fnId = logicalId(on.main, 'AWS::Lambda::Function', 'RegistrarFunction');
    expect(dependsOn(on.main, fnId)).toContain(logicalId(on.main, 'AWS::IAM::Policy', 'RegistrarDedicatedDomainsPolicy'));
  });
});

describe('dedicatedDomains on: sweeper (spec §3.1, §3.4 step 5, ADR-0020, ADR-0022)', () => {
  it('runs one Node.js 24 ARM function with a 15-minute timeout, JSON logs, its own role and log group, and SWEEPER_ENV', () => {
    const fn = sweeperFunction(on.main);
    expect(fn).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'], Timeout: 900, LoggingConfig: { LogFormat: 'JSON' } });
    expect(fn.Role['Fn::GetAtt'][0]).toMatch(/^SweeperFunctionServiceRole/);
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual(Object.values(SWEEPER_ENV).sort());
    expect(fn.Environment.Variables).toEqual({
      [SWEEPER_ENV.routeTableArn]: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] },
      [SWEEPER_ENV.distributionId]: DISTRIBUTION,
      [SWEEPER_ENV.tableName]: { Ref: logicalId(on.main, 'AWS::DynamoDB::Table', 'SweeperTable') },
    });
    const logGroup = resources(on.main)[fn.LoggingConfig.LogGroup.Ref];
    expect(logGroup.Properties.RetentionInDays).toBe(14);
  });

  it('keeps the re-check state in an on-demand table with string pk and sk, PITR and TTL expiresAt', () => {
    expect(only(on.main, 'AWS::DynamoDB::Table')).toEqual({
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
    on.main.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  it('keeps an asynchronous event 3 hours with two retries, then sends it to an encrypted, TLS-only queue', () => {
    const queueId = logicalId(on.main, 'AWS::SQS::Queue', 'SweeperOnFailure');
    expect(only(on.main, 'AWS::Lambda::EventInvokeConfig')).toMatchObject({
      MaximumEventAgeInSeconds: 10800,
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [queueId, 'Arn'] } } },
    });
    expect(only(on.main, 'AWS::SQS::Queue')).toMatchObject({ SqsManagedSseEnabled: true });
    expect(only(on.main, 'AWS::SQS::QueuePolicy').PolicyDocument.Statement).toContainEqual(expect.objectContaining({
      Effect: 'Deny',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    }));
  });

  it('holds exactly the actions spec §3.4 lists for the sweeper role, writes conditioned on the registrar\'s tag', () => {
    const list = statements(on.main, 'SweeperFunctionServiceRole');
    const table = { 'Fn::GetAtt': [logicalId(on.main, 'AWS::DynamoDB::Table', 'SweeperTable'), 'Arn'] };
    expect(bySid(list, 'RouteTableRead')).toEqual({
      Action: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:ListKeys', 'cloudfront-keyvaluestore:GetKey'],
      Resource: { 'Fn::GetAtt': [expect.stringMatching(/^RouteTable/), 'Arn'] },
    });
    expect(bySid(list, 'DistributionTenantList')).toEqual({ Action: 'cloudfront:ListDistributionTenants', Resource: '*' });
    expect(bySid(list, 'DistributionTenantRead')).toEqual({ Action: 'cloudfront:GetDistributionTenant', Resource: TENANT_ARNS });
    expect(bySid(list, 'DistributionTenantRemove')).toEqual({
      Action: ['cloudfront:UpdateDistributionTenant', 'cloudfront:DeleteDistributionTenant'],
      Resource: TENANT_ARNS,
      Condition: DISTRIBUTION_TAG,
    });
    expect(bySid(list, 'CertificateList')).toEqual({ Action: 'acm:ListCertificates', Resource: '*', Condition: IN_US_EAST_1 });
    expect(bySid(list, 'CertificateRead')).toEqual({ Action: ['acm:ListTagsForCertificate', 'acm:DescribeCertificate'], Resource: CERT_ARNS });
    expect(bySid(list, 'CertificateDelete')).toEqual({ Action: 'acm:DeleteCertificate', Resource: CERT_ARNS, Condition: DISTRIBUTION_TAG });
    expect(bySid(list, 'Table')).toEqual({
      Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
      Resource: table,
    });
    expect(bySid(list, 'OnFailure')).toEqual({ Action: 'sqs:SendMessage', Resource: { 'Fn::GetAtt': [logicalId(on.main, 'AWS::SQS::Queue', 'SweeperOnFailure'), 'Arn'] } });
    expect(bySid(list, 'FanOut')).toEqual({ Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [logicalId(on.main, 'AWS::Lambda::Function', 'SweeperFunction'), 'Arn'] } });
    expect(actions(list).sort()).toEqual([
      'acm:DeleteCertificate', 'acm:DescribeCertificate', 'acm:ListCertificates', 'acm:ListTagsForCertificate',
      'cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey', 'cloudfront-keyvaluestore:ListKeys',
      'cloudfront:DeleteDistributionTenant', 'cloudfront:GetDistributionTenant', 'cloudfront:ListDistributionTenants', 'cloudfront:UpdateDistributionTenant',
      'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      'lambda:InvokeFunction', 'sqs:SendMessage',
    ]);
  });

  it('gives no other role in the stack access to the sweeper table', () => {
    const table = logicalId(on.main, 'AWS::DynamoDB::Table', 'SweeperTable');
    const others = Object.values(resources(on.main))
      .filter((r) => r.Type === 'AWS::IAM::Policy' && !r.Properties.Roles.some((x: any) => x.Ref?.startsWith('SweeperFunctionServiceRole')));
    expect(others.filter((r) => JSON.stringify(r.Properties.PolicyDocument).includes(table))).toEqual([]);
  });

  it('runs remove every 15 minutes and the re-check daily at 02:00 UTC with 2 retries and 1 hour maximum age', () => {
    const fnArn = { 'Fn::GetAtt': [logicalId(on.main, 'AWS::Lambda::Function', 'SweeperFunction'), 'Arn'] };
    const dlq = { Arn: { 'Fn::GetAtt': [logicalId(on.main, 'AWS::SQS::Queue', 'SweeperOnFailure'), 'Arn'] } };
    const remove = resources(on.main)[logicalId(on.main, 'AWS::Scheduler::Schedule', 'SweeperRemoveSchedule')].Properties;
    expect(remove).toMatchObject({
      ScheduleExpression: 'rate(15 minutes)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: fnArn,
        Input: SWEEPER_REMOVE_INPUT,
        RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 2 },
        DeadLetterConfig: dlq,
      },
    });
    const recheck = resources(on.main)[logicalId(on.main, 'AWS::Scheduler::Schedule', 'SweeperRecheckSchedule')].Properties;
    expect(recheck).toMatchObject({
      ScheduleExpression: 'cron(0 2 * * ? *)',
      ScheduleExpressionTimezone: 'Etc/UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: fnArn,
        Input: SWEEPER_RECHECK_INPUT,
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
        DeadLetterConfig: dlq,
      },
    });
    // The daily input names no date (ADR-0022).
    expect(JSON.parse(recheck.Target.Input)).toEqual({ job: 'recheck' });
  });

  it('starts the first re-check from a starter that holds only lambda:InvokeFunction on the sweeper', () => {
    const fnId = logicalId(on.main, 'AWS::Lambda::Function', 'SweeperFunction');
    expect(only(on.main, 'Custom::TenantFrontDoorSweeperStarter')).toMatchObject({ SweeperFunctionName: { Ref: fnId } });
    expect(statements(on.main, 'SweeperStarterFunctionServiceRole').map(({ Sid, ...s }) => s)).toEqual([
      { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: { 'Fn::GetAtt': [fnId, 'Arn'] } },
    ]);
  });

  it('alarms on three misses, unverifiable, queue depth, missing pages and no lister, each with the topic as ALARM action', () => {
    const alarms = Object.values(resources(onHost.main)).filter((r) => r.Type === 'AWS::CloudWatch::Alarm').map((r) => r.Properties);
    expect(alarms).toHaveLength(6);
    for (const a of alarms) expect(a.AlarmActions).toEqual([TOPIC]);
    const byMetric = (name: string, statistic: string) => alarms.find((a) => a.MetricName === name && a.Statistic === statistic);
    expect(byMetric(SWEEPER_METRICS.threeMiss, 'Sum')).toMatchObject({
      Namespace: SWEEPER_METRIC_NAMESPACE, Period: 3600, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', EvaluationPeriods: 1, TreatMissingData: 'notBreaching',
    });
    expect(byMetric(SWEEPER_METRICS.unverifiable, 'Sum')).toMatchObject({
      Namespace: SWEEPER_METRIC_NAMESPACE, Period: 3600, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    });
    expect(byMetric(SWEEPER_METRICS.missingPages, 'Maximum')).toMatchObject({
      Namespace: SWEEPER_METRIC_NAMESPACE,
      Period: 86400,
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
    });
    expect(byMetric(SWEEPER_METRICS.missingPages, 'SampleCount')).toMatchObject({
      Namespace: SWEEPER_METRIC_NAMESPACE,
      Period: 86400,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      TreatMissingData: 'breaching',
    });
    expect(byMetric('ApproximateNumberOfMessagesVisible', 'Maximum')).toMatchObject({
      Namespace: 'AWS/SQS', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    });
  });

  it('adds no alarm action without alarmTopicArn', () => {
    for (const r of Object.values(resources(on.main)).filter((x) => x.Type === 'AWS::CloudWatch::Alarm')) {
      expect(r.Properties.AlarmActions).toBeUndefined();
    }
  });
});

describe('dedicatedDomains on: guard (spec §3.4)', () => {
  it('takes DedicatedDomains on and runs a 2-minute function that only reads', () => {
    expect(only(on.main, 'Custom::TenantFrontDoorDedicatedDomainsGuard')).toMatchObject({ DedicatedDomains: 'on' });
    const fn = resources(on.main)[logicalId(on.main, 'AWS::Lambda::Function', 'DedicatedDomainsGuardFunction')].Properties;
    expect(fn.Timeout).toBe(120);
    const list = statements(on.main, 'DedicatedDomainsGuardFunction');
    expect(actions(list).sort()).toEqual([
      'acm:ListCertificates', 'acm:ListTagsForCertificate',
      'cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:ListKeys',
      'cloudfront:ListDistributionTenants',
    ]);
    expect(bySid(list, 'CertificateList')).toMatchObject({ Condition: IN_US_EAST_1 });
  });

  it('waits the 10 s Lambda init limit plus the registrar timeout, inside its own timeout', () => {
    expect(REGISTRAR_DRAIN_MS).toBe(10_000 + REGISTRAR_TIMEOUT.toMilliseconds());
    expect(REGISTRAR_DRAIN_MS).toBeLessThan(120_000);
  });
});

describe('dedicatedDomains on: teardown (spec §6.2)', () => {
  it('polls with the provider framework and holds only the removal actions, writes conditioned on the registrar\'s tag', () => {
    const list = statements(on.main, 'DedicatedDomainsTeardownIsComplete');
    expect(actions(list).sort()).toEqual([
      'acm:DeleteCertificate', 'acm:ListCertificates', 'acm:ListTagsForCertificate',
      'cloudfront:DeleteDistributionTenant', 'cloudfront:GetDistributionTenant', 'cloudfront:ListDistributionTenants', 'cloudfront:UpdateDistributionTenant',
    ]);
    expect(bySid(list, 'DistributionTenantRemove')).toMatchObject({ Condition: DISTRIBUTION_TAG });
    expect(bySid(list, 'CertificateDelete')).toMatchObject({ Condition: DISTRIBUTION_TAG });
    expect(statements(on.main, 'DedicatedDomainsTeardownOnEvent').filter((s) => s.Sid !== undefined)).toEqual([]);
    on.main.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    expect(only(on.main, 'AWS::StepFunctions::StateMachine').LoggingConfiguration).toMatchObject({ Level: 'ALL', IncludeExecutionData: false });
  });
});

describe('dedicatedDomains on: deploy order (spec §3.4, §6.2)', () => {
  const ids = {
    registrar: logicalId(on.main, 'AWS::Lambda::Function', 'RegistrarFunction'),
    guard: logicalId(on.main, 'Custom::TenantFrontDoorDedicatedDomainsGuard', 'DedicatedDomainsGuard'),
    teardown: logicalId(on.main, 'Custom::TenantFrontDoorDedicatedDomainsTeardown', 'DedicatedDomainsTeardown'),
    starter: logicalId(on.main, 'Custom::TenantFrontDoorSweeperStarter', 'SweeperStarter'),
    sweeper: logicalId(on.main, 'AWS::Lambda::Function', 'SweeperFunction'),
  };

  it('updates the registrar function before the guard', () => {
    expect(dependsOn(on.main, ids.guard)).toContain(ids.registrar);
  });

  it('puts both schedules after the guard', () => {
    for (const id of Object.keys(resources(on.main)).filter((x) => resources(on.main)[x].Type === 'AWS::Scheduler::Schedule')) {
      expect(dependsOn(on.main, id)).toContain(ids.guard);
    }
  });

  it('deploys the starter after the sweeper, its table, queue, fan-out grant and asynchronous configuration', () => {
    const deps = dependsOn(on.main, ids.starter);
    for (const id of [
      ids.sweeper,
      logicalId(on.main, 'AWS::DynamoDB::Table', 'SweeperTable'),
      logicalId(on.main, 'AWS::SQS::Queue', 'SweeperOnFailure'),
      logicalId(on.main, 'AWS::IAM::Policy', 'SweeperFanOut'),
      logicalId(on.main, 'AWS::Lambda::EventInvokeConfig', 'SweeperFunction'),
    ]) {
      expect(deps).toContain(id);
    }
  });

  it('runs the teardown on the distribution, and after the registrar function on a stack delete', () => {
    expect(only(on.main, 'Custom::TenantFrontDoorDedicatedDomainsTeardown').DistributionId).toEqual(DISTRIBUTION);
    expect(dependsOn(on.main, ids.registrar)).toContain(ids.teardown);
    expect(dependsOn(off.main, logicalId(off.main, 'AWS::Lambda::Function', 'RegistrarFunction'))).toContain(ids.teardown);
  });
});
