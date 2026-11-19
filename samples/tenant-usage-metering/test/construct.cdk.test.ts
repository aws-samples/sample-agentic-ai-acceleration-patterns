// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { hourQuery } from '../src/construct/pipeline';
import { resolveProps, type TenantUsageMeteringProps } from '../src/construct/props';
import { subscriberFilters, UsageSubscriber, type UsageSubscriberProps } from '../src/subscriber/usage-subscriber';
import { TenantUsageMetering } from '../src/tenant-usage-metering';

const ACCOUNT = '111122223333';
const REGISTRAR = `arn:aws:iam::${ACCOUNT}:role/demo-global-hook`;
const OPERATOR = `arn:aws:iam::${ACCOUNT}:role/metering-operator`;
const base: TenantUsageMeteringProps = { fleetName: 'demo', registrarPrincipalArns: [REGISTRAR], operatorPrincipalArns: [OPERATOR] };

function synth(props: Partial<TenantUsageMeteringProps> = {}): Template {
  // No asset bundling in unit tests: the functions' code is not under test here.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Test', { env: { account: ACCOUNT, region: 'eu-central-1' } });
  new TenantUsageMetering(stack, 'Metering', { ...base, ...props });
  return Template.fromStack(stack);
}

type PolicyResource = { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

const statementsOf = (template: Template, type: string, match: (logicalId: string) => boolean): Array<Record<string, unknown>> =>
  Object.entries(template.findResources(type))
    .filter(([id]) => match(id))
    .flatMap(([, resource]) => (resource as PolicyResource).Properties.PolicyDocument.Statement);

describe('props (spec §3.3)', () => {
  test('defaults', () => {
    const resolved = resolveProps(base);
    expect(resolved).toMatchObject({
      lateGraceMinutes: 15,
      recountWindowHours: 96,
      errorRetentionDays: 30,
      maxEventsPerEmitterPerMinute: 3000,
      ingestPath: 'BUS',
      ingestBusRetentionDays: 1,
      usageBusRetentionDays: 7,
    });
  });

  test.each([
    ['a fleet name outside the charset', { fleetName: 'Demo_Fleet' }, /fleetName/],
    ['no registrar', { registrarPrincipalArns: [] }, /registrarPrincipalArns must name at least one role/],
    ['a registrar that is also an operator', { operatorPrincipalArns: [REGISTRAR] }, /both a registrar and an operator/],
    ['a grace below the Firehose buffer plus 5 minutes', { lateGraceMinutes: 5 }, /lateGraceMinutes/],
    ['a recount window below 72 hours', { recountWindowHours: 48 }, /recountWindowHours/],
    ['an error retention below the window in days plus 7', { recountWindowHours: 96, errorRetentionDays: 10 }, /errorRetentionDays must be an integer from 11/],
    ['a bus retention over 365 days', { usageBusRetentionDays: 366 }, /usageBusRetentionDays/],
    ['a subscriber account that is not 12 digits', { rawSubscriberAccountIds: ['123'] }, /rawSubscriberAccountIds/],
    ['a non-role principal', { operatorPrincipalArns: [`arn:aws:iam::${ACCOUNT}:user/alice`] }, /not an IAM role ARN/],
  ])('%s fails synth', (_label, props, message) => {
    expect(() => resolveProps({ ...base, ...props } as TenantUsageMeteringProps)).toThrow(message);
  });
});

describe('table (spec §4)', () => {
  const template = synth();

  test('PITR, TTL, a stream with both images, and the two sparse indexes', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'pending-hours', KeySchema: [{ AttributeName: 'pending', KeyType: 'HASH' }, { AttributeName: 'PK', KeyType: 'RANGE' }] }),
        Match.objectLike({ IndexName: 'publish-outbox', KeySchema: [{ AttributeName: 'publishShard', KeyType: 'HASH' }, { AttributeName: 'publishPending', KeyType: 'RANGE' }] }),
      ]),
    });
  });

  test('a resource policy denies item writes, PartiQL included, to all but the stack roles (M-24)', () => {
    const table = Object.values(template.findResources('AWS::DynamoDB::GlobalTable'))[0] as { Properties: { Replicas: Array<{ ResourcePolicy: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }> } };
    const [statement] = table.Properties.Replicas[0].ResourcePolicy.PolicyDocument.Statement;
    expect(statement).toMatchObject({ Effect: 'Deny', Principal: { AWS: '*' } });
    expect(statement.Action).toEqual(expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:PartiQLInsert', 'dynamodb:PartiQLUpdate', 'dynamodb:PartiQLDelete']));
    const allowed = (statement.Condition as { ArnNotEquals: { 'aws:PrincipalArn': unknown[] } }).ArnNotEquals['aws:PrincipalArn'];
    expect(allowed).toHaveLength(10);
  });
});

describe('raw and export buckets (spec §3.5, M-24)', () => {
  const template = synth();
  const raw = statementsOf(template, 'AWS::S3::BucketPolicy', (id) => id.includes('RawBucket'));
  const exp = statementsOf(template, 'AWS::S3::BucketPolicy', (id) => id.includes('ExportBucket'));
  const sids = (statements: Array<Record<string, unknown>>): unknown[] => statements.map((s) => s.Sid).filter((s) => s !== undefined);

  test('each prefix has one writer, deletes and configuration changes are denied', () => {
    expect(sids(raw)).toEqual(
      expect.arrayContaining([
        'DenyRawWritesExceptFirehose',
        'DenyReadmittedWritesExceptReadmission',
        'DenyErrorWritesExceptPipeline',
        'DenyWritesOutsideThePrefixes',
        'DenyDeletesExceptAutoDelete',
        'DenyConfigurationChanges',
      ]),
    );
    expect(sids(exp)).toEqual(expect.arrayContaining(['DenyExportWritesExceptDispatcher', 'DenyDeletesExceptAutoDelete', 'DenyConfigurationChanges']));
    const config = raw.find((s) => s.Sid === 'DenyConfigurationChanges')!;
    expect(config.Action).toEqual(['s3:PutLifecycleConfiguration', 's3:PutBucketVersioning', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutBucketNotification']);
    expect(JSON.stringify(config.Condition)).toContain('cdk-hnb659fds-cfn-exec-role-');
  });

  test('a deploymentRoleArn replaces the bootstrap role in the exemption', () => {
    const custom = `arn:aws:iam::${ACCOUNT}:role/my-cfn-role`;
    const statements = statementsOf(synth({ deploymentRoleArn: custom }), 'AWS::S3::BucketPolicy', (id) => id.includes('RawBucket'));
    const config = statements.find((s) => s.Sid === 'DenyConfigurationChanges')!;
    expect(JSON.stringify(config.Condition)).toContain(custom);
    expect(JSON.stringify(config.Condition)).not.toContain('cfn-exec-role');
  });

  test('versioned, with current and noncurrent expiry per prefix', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'ExpireRaw', Prefix: 'raw/', ExpirationInDays: 400, NoncurrentVersionExpiration: { NoncurrentDays: 7 } }),
          Match.objectLike({ Id: 'ExpireErrors', Prefix: 'error/', ExpirationInDays: 30 }),
          Match.objectLike({ Id: 'RemoveExpiredDeleteMarkers', ExpiredObjectDeleteMarker: true }),
        ]),
      },
    });
  });
});

describe('ingest pipeline (ADR-0002, spec §3.1)', () => {
  test('BUS: a Custom Event Bus with a Firehose subscriber, a 24 h retry policy and a dead-letter queue', () => {
    const template = synth();
    template.resourceCountIs('AWS::EventsV2::EventBus', 2);
    template.hasResourceProperties('AWS::EventsV2::EventBus', { StorageConfiguration: { RetentionPeriodInDays: 1 } });
    template.hasResourceProperties('AWS::EventsV2::Subscriber', {
      Type: 'UNORDERED',
      BatchConfiguration: { MaxBatchSize: 500, MaxBatchWindowInSeconds: 5 },
      RetryPolicy: { MaxEventAgeInSeconds: 86400 },
      OnFailureConfiguration: { Arn: Match.anyValue() },
      InvokeConfiguration: { TargetArn: Match.anyValue(), RoleArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      ExtendedS3DestinationConfiguration: Match.objectLike({
        Prefix: 'raw/hour=!{partitionKeyFromQuery:hour}/',
        ErrorOutputPrefix: 'firehose-error/!{firehose:error-output-type}/',
        DynamicPartitioningConfiguration: { Enabled: true, RetryOptions: { DurationInSeconds: 300 } },
      }),
    });
  });

  test('each bus is published to only by its writer', () => {
    const template = synth();
    const policies = Object.values(template.findResources('AWS::EventsV2::ResourcePolicy')) as Array<{ Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }>;
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.Properties.PolicyDocument.Statement[0]).toMatchObject({ Effect: 'Deny', Action: ['events:PutEvents', 'events:PutRawEvents'] });
    }
    // The deny exempts the writer but grants nothing: each writer needs its own allow.
    const allows = statementsOf(template, 'AWS::IAM::Policy', () => true).filter((s) => s.Effect === 'Allow' && s.Action === 'events:PutEvents');
    expect(allows).toHaveLength(2);
  });

  test('the dead-letter queue denies sends from anyone but the ingest subscriber', () => {
    const [deny] = statementsOf(synth(), 'AWS::SQS::QueuePolicy', () => true).filter((s) => s.Effect === 'Deny' && s.Sid === 'DenySendExceptTheIngestSubscriber');
    expect(Object.keys(deny.Condition as object).sort()).toEqual(['ArnNotEquals', 'ArnNotLike']);
  });

  test('DIRECT: no ingest bus, no subscriber; the partition key is the packed record hour', () => {
    const template = synth({ ingestPath: 'DIRECT' });
    template.resourceCountIs('AWS::EventsV2::EventBus', 1);
    template.resourceCountIs('AWS::EventsV2::Subscriber', 0);
    expect(hourQuery('DIRECT')).toBe('{hour: .hour}');
    expect(hourQuery('BUS')).toBe('{hour: .detail.time[0:13]}');
  });
});

describe('API (spec §3.2, §5)', () => {
  const template = synth({ readerPrincipalArns: [`arn:aws:iam::${ACCOUNT}:role/usage-reader`] });

  test('every method is AWS_IAM', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as Array<{ Properties: { AuthorizationType: string; HttpMethod: string } }>;
    expect(methods.length).toBe(30);
    expect(methods.every((method) => method.Properties.AuthorizationType === 'AWS_IAM' || method.Properties.HttpMethod === 'OPTIONS')).toBe(true);
  });

  test('each allow of the resource policy has an explicit deny for everyone else', () => {
    const api = Object.values(template.findResources('AWS::ApiGateway::RestApi'))[0] as { Properties: { Policy: { Statement: Array<Record<string, unknown>> } } };
    const statements = api.Properties.Policy.Statement;
    const allows = statements.filter((s) => s.Effect === 'Allow');
    const denies = statements.filter((s) => s.Effect === 'Deny');
    expect(allows.length).toBe(4);
    expect(denies.length).toBe(4);
    const ingestDeny = denies.find((s) => s.Sid === 'DenyIngestToOtherPrincipals')!;
    // The stack's own partition, not a hard-coded `aws`.
    expect(ingestDeny.Condition).toEqual({
      ArnNotLike: { 'aws:PrincipalArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::*:role/demo-ue-*']] } },
    });
    const registrarDeny = denies.find((s) => s.Sid === 'DenyRegistrarRoutesToOthers')!;
    expect(registrarDeny.Resource).toEqual(expect.arrayContaining(['execute-api:/*/PUT/cells/*/emitter', 'execute-api:/*/DELETE/cells/*/tenants/*']));
    expect(registrarDeny.Condition).toEqual({ ArnNotEquals: { 'aws:PrincipalArn': [REGISTRAR] } });
  });

  test('the ingest method has its own throttle below the stage limit', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ ResourcePath: '/~1usage-events', HttpMethod: 'POST', ThrottlingRateLimit: 600 })]),
    });
  });
});

describe('functions, recounter and alarms (spec §3.1)', () => {
  const template = synth();

  test('the ingest function has reserved concurrency; every function runs Node 24 on ARM', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{ Properties: { Runtime?: string; Architectures?: string[]; ReservedConcurrentExecutions?: number; Environment?: { Variables?: Record<string, unknown> } } }>;
    const ours = functions.filter((fn) => fn.Properties.Environment?.Variables?.METERING_TABLE_NAME !== undefined);
    expect(ours).toHaveLength(10);
    expect(ours.every((fn) => fn.Properties.Runtime === 'nodejs24.x' && fn.Properties.Architectures?.[0] === 'arm64')).toBe(true);
    expect(ours.filter((fn) => fn.Properties.ReservedConcurrentExecutions === 25)).toHaveLength(1);
  });

  test('the recounter times out before its lease and logs no execution data', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: Match.objectLike({ IncludeExecutionData: false, Level: 'ALL' }),
    });
    const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as { Properties: { DefinitionString: unknown } };
    expect(JSON.stringify(machine.Properties.DefinitionString)).toContain('TimeoutSeconds\\":1500');
  });

  test('two 5-minute schedules: the scheduler and the outbox sweep', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(5 minutes)', Target: Match.objectLike({ Input: '{"sweep":true}' }) });
  });

  test('the publisher reads only usage records holding a marker', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { NewImage: { PK: { S: [{ prefix: 'USAGE#' }] }, publishPending: { S: [{ exists: true }] } } } }) }] },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('the alarms of the specification exist, the heartbeat breaching on missing data', () => {
    expect(Object.keys(template.findResources('AWS::CloudWatch::Alarm')).length).toBe(16);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Invocations', TreatMissingData: 'breaching', EvaluationPeriods: 3 });
  });

  test('the bucket configuration deny exempts the notifications provider', () => {
    const denies = statementsOf(template, 'AWS::S3::BucketPolicy', (id) => id.includes('RawBucket')).filter((s) => s.Sid === 'DenyConfigurationChanges');
    expect(denies).toHaveLength(1);
    const allowed = (denies[0].Condition as { ArnNotEquals: Record<string, unknown[]> }).ArnNotEquals['aws:PrincipalArn'];
    expect(JSON.stringify(allowed)).toContain('BucketNotificationsHandler');
  });
});

describe('UsageSubscriber (spec §6.3, ADR-0006)', () => {
  const BUS = 'arn:aws:events:eu-central-1:111122223333:event-busv2/demo-usage/abcdefghijklmnopqrstuvwxy';
  const subscribe = (props: Partial<UsageSubscriberProps> = {}) => {
    const app = new App();
    const stack = new Stack(app, 'Reader', { env: { account: ACCOUNT, region: 'eu-central-1' } });
    const role = new iam.Role(stack, 'DeliveryRole', { assumedBy: new iam.AccountRootPrincipal() });
    const reader = new UsageSubscriber(stack, 'Reader', { busArn: BUS, targetArn: 'arn:aws:sqs:eu-central-1:111122223333:billing', role, ...props });
    return { template: Template.fromStack(stack), reader };
  };

  test('always a dead-letter queue, 24 h of retries and two alarms', () => {
    const { template, reader } = subscribe();
    template.hasResourceProperties('AWS::EventsV2::Subscriber', {
      EventBusArn: BUS,
      Type: 'UNORDERED',
      StartingPosition: 'LATEST',
      RetryPolicy: { MaxEventAgeInSeconds: 86400, MaxRetryAttempts: 185 },
      OnFailureConfiguration: { Arn: Match.anyValue() },
      InvokeConfiguration: { TargetArn: 'arn:aws:sqs:eu-central-1:111122223333:billing', RoleArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 1209600, SqsManagedSseEnabled: true });
    expect(reader.alarms).toHaveLength(2);
    expect(template.findResources('AWS::EventsV2::Subscriber')[Object.keys(template.findResources('AWS::EventsV2::Subscriber'))[0]].Properties.FilterConfiguration).toBeUndefined();
  });

  test('meter and tenant filters go on the payload; a bad value fails synth', () => {
    expect(subscriberFilters(['agent.tokens'], ['tenant-a'])).toEqual([{ scope: 'DATA', pattern: '{"detail":{"meterId":["agent.tokens"],"tenantId":["tenant-a"]}}' }]);
    const { template } = subscribe({ meters: ['agent.tokens'], type: 'FIFO', startingPosition: new Date('2026-11-18T00:00:00Z') });
    template.hasResourceProperties('AWS::EventsV2::Subscriber', {
      Type: 'FIFO',
      StartingPosition: 'POINT_IN_TIME',
      PointInTimeConfiguration: { PointType: 'TIMESTAMP', StartingPoint: 1794960000 },
      FilterConfiguration: { Filters: [{ Scope: 'DATA', Pattern: '{"detail":{"meterId":["agent.tokens"]}}' }] },
    });
    expect(() => subscribe({ tenants: ['bad tenant'] })).toThrow(/charset/);
    expect(() => subscribe({ maxEventAge: Duration.hours(25) })).toThrow(/24 hours/);
  });
});
