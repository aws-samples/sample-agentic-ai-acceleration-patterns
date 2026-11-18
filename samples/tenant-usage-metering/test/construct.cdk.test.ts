// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { hourQuery } from '../src/construct/pipeline';
import { resolveProps, type TenantUsageMeteringProps } from '../src/construct/props';
import { TenantUsageMetering } from '../src/tenant-usage-metering';

const ACCOUNT = '111122223333';
const REGISTRAR = `arn:aws:iam::${ACCOUNT}:role/demo-global-hook`;
const OPERATOR = `arn:aws:iam::${ACCOUNT}:role/metering-operator`;
const base: TenantUsageMeteringProps = { fleetName: 'demo', registrarPrincipalArns: [REGISTRAR], operatorPrincipalArns: [OPERATOR] };

function synth(props: Partial<TenantUsageMeteringProps> = {}): Template {
  const app = new App();
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
    expect(allowed).toHaveLength(9);
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
