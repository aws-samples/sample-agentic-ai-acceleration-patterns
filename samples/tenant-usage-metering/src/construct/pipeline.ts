// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingest pipeline after the ingest function (ADR-0002, spec §3.1,
 * §3.5): the ingest bus, its Firehose subscriber and dead-letter queue, the
 * Firehose stream into `raw/` partitioned by event hour, and the usage bus.
 *
 * Both buses are EventBridge Custom Event Buses (`AWS::EventsV2::*`). Each
 * has a resource policy that denies publishing to every principal but its
 * one writer, so no other principal in the account can put a raw event or
 * a `UsageRecorded` on them.
 *
 * A bus with subscriber accounts is shared with them through AWS RAM under
 * the managed SubscribeOnly permission (spec §3.2, ADR-0006), after the
 * share guard has checked that none of them holds a cell.
 */

import { Aws, Duration, Stack, Validations } from 'aws-cdk-lib';
import * as eventsv2 from 'aws-cdk-lib/aws-eventsv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as ram from 'aws-cdk-lib/aws-ram';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct, type IDependable } from 'constructs';
import type { IngestPath, ResolvedProps } from './props';
import type { ServiceRoles } from './roles';
import { FIREHOSE_ERROR_PREFIX, RAW_PREFIX } from './storage';

/** The subscriber retries for the longest event age the bus allows (ADR-0002). */
export const SUBSCRIBER_MAX_EVENT_AGE = Duration.hours(24);
/** The most attempts a subscriber's retry policy takes (AWS::EventsV2::Subscriber). */
export const SUBSCRIBER_MAX_RETRY_ATTEMPTS = 185;

export interface Pipeline {
  readonly ingestBus?: eventsv2.CfnEventBus;
  readonly ingestSubscriber?: eventsv2.CfnSubscriber;
  readonly ingestDeadLetterQueue?: sqs.Queue;
  readonly usageBus: eventsv2.CfnEventBus;
  readonly stream: firehose.CfnDeliveryStream;
  readonly ingestBusArn?: string;
  readonly usageBusArn: string;
}

export interface PipelineNames {
  readonly firehoseStreamName: string;
  readonly ingestBusName: string;
  readonly usageBusName: string;
  readonly ingestSubscriberName: string;
  readonly ingestShareName: string;
  readonly usageShareName: string;
}

/** The AWS RAM managed permission a bus is shared under: subscribe, never publish. */
export const BUS_SHARE_PERMISSION = 'AWSRAMEventBridgeEventBusV2SubscribeOnly';

/** The JQ query that names an object's hour partition (spec §4.8). */
export function hourQuery(path: IngestPath): string {
  return path === 'BUS' ? '{hour: .detail.time[0:13]}' : '{hour: .hour}';
}

function publishOnlyBy(scope: Construct, id: string, bus: eventsv2.CfnEventBus, writer: iam.Role): void {
  // The deny only removes every other principal; the writer still needs an
  // identity allow (seen in a test account: without it the writer was refused too).
  writer.addToPolicy(new iam.PolicyStatement({ actions: ['events:PutEvents'], resources: [bus.attrEventBusArn] }));
  new eventsv2.CfnResourcePolicy(scope, id, {
    eventBusArn: bus.attrEventBusArn,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyPublishExceptTheWriter',
          Effect: 'Deny',
          Principal: '*',
          Action: ['events:PutEvents', 'events:PutRawEvents'],
          Resource: bus.attrEventBusArn,
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': writer.roleArn } },
        },
      ],
    },
  });
}

/**
 * Shares each bus with its subscriber accounts through AWS RAM: the ingest
 * bus (on `BUS` only) with `rawSubscriberAccountIds`, the usage bus with
 * `usageSubscriberAccountIds`. A bus with an empty list is not shared.
 * Every share depends on `guard`, the registry check of ADR-0006.
 */
export function shareBuses(
  scope: Construct,
  props: ResolvedProps,
  pipeline: Pipeline,
  names: PipelineNames,
  guard: IDependable,
): ram.CfnResourceShare[] {
  const permissionArn = `arn:${Aws.PARTITION}:ram::aws:permission/${BUS_SHARE_PERMISSION}`;
  const shares: Array<[string, string, eventsv2.CfnEventBus | undefined, string[]]> = [
    ['IngestBusShare', names.ingestShareName, pipeline.ingestBus, props.rawSubscriberAccountIds],
    ['UsageBusShare', names.usageShareName, pipeline.usageBus, props.usageSubscriberAccountIds],
  ];
  const out: ram.CfnResourceShare[] = [];
  for (const [id, name, bus, accountIds] of shares) {
    if (bus === undefined || accountIds.length === 0) {
      continue;
    }
    const share = new ram.CfnResourceShare(scope, id, {
      name,
      resourceArns: [bus.attrEventBusArn],
      principals: [...new Set(accountIds)],
      permissionArns: [permissionArn],
      // Vendor accounts need not be in this account's organization.
      allowExternalPrincipals: true,
    });
    share.node.addDependency(guard);
    out.push(share);
  }
  return out;
}

export function createPipeline(scope: Construct, props: ResolvedProps, roles: ServiceRoles, rawBucket: s3.Bucket, names: PipelineNames): Pipeline {
  const stack = Stack.of(scope);

  const stream = new firehose.CfnDeliveryStream(scope, 'RawStream', {
    deliveryStreamName: names.firehoseStreamName,
    deliveryStreamType: 'DirectPut',
    deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
    extendedS3DestinationConfiguration: {
      bucketArn: rawBucket.bucketArn,
      roleArn: roles.firehose.roleArn,
      prefix: `${RAW_PREFIX}hour=!{partitionKeyFromQuery:hour}/`,
      errorOutputPrefix: `${FIREHOSE_ERROR_PREFIX}!{firehose:error-output-type}/`,
      // Dynamic partitioning needs a buffer of at least 64 MB; the 60-second
      // interval is what `lateGraceMinutes` must exceed (spec §3.3).
      bufferingHints: { intervalInSeconds: 60, sizeInMBs: 64 },
      dynamicPartitioningConfiguration: { enabled: true, retryOptions: { durationInSeconds: 300 } },
      processingConfiguration: {
        enabled: true,
        processors: [
          {
            type: 'MetadataExtraction',
            parameters: [
              { parameterName: 'MetadataExtractionQuery', parameterValue: hourQuery(props.ingestPath) },
              { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
            ],
          },
        ],
      },
    },
  });
  rawBucket.grantPut(roles.firehose, `${RAW_PREFIX}*`);
  rawBucket.grantPut(roles.firehose, `${FIREHOSE_ERROR_PREFIX}*`);
  roles.firehose.addToPolicy(
    new iam.PolicyStatement({ actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'], resources: [rawBucket.bucketArn] }),
  );
  stream.node.addDependency(roles.firehose);

  const usageBus = new eventsv2.CfnEventBus(scope, 'UsageBus', {
    name: names.usageBusName,
    description: 'tenant-usage-metering: one UsageRecorded per usage record revision (spec §3.1)',
    storageConfiguration: { retentionPeriodInDays: props.usageBusRetentionDays },
  });
  publishOnlyBy(scope, 'UsageBusPolicy', usageBus, roles.publisher);

  if (props.ingestPath === 'DIRECT') {
    return { usageBus, stream, usageBusArn: usageBus.attrEventBusArn };
  }

  const ingestBus = new eventsv2.CfnEventBus(scope, 'IngestBus', {
    name: names.ingestBusName,
    description: 'tenant-usage-metering: checked usage events (ADR-0002)',
    storageConfiguration: { retentionPeriodInDays: props.ingestBusRetentionDays },
  });
  publishOnlyBy(scope, 'IngestBusPolicy', ingestBus, roles.ingest);

  const subscriberArnPattern = stack.formatArn({ service: 'events', resource: 'subscriber', resourceName: `${names.ingestSubscriberName}/*` });
  const ingestDeadLetterQueue = new sqs.Queue(scope, 'IngestDeadLetterQueue', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
  });
  Validations.of(ingestDeadLetterQueue).acknowledge({
    id: 'AwsSolutions-SQS3',
    reason: 'This is the ingest subscriber dead-letter queue itself; StartIngestRedrive drains it (spec §3.1).',
  });
  ingestDeadLetterQueue.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowTheIngestSubscriber',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [ingestDeadLetterQueue.queueArn],
      conditions: { ArnLike: { 'aws:SourceArn': subscriberArnPattern }, StringEquals: { 'aws:SourceAccount': stack.account } },
    }),
  );
  ingestDeadLetterQueue.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenySendExceptTheIngestSubscriber',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sqs:SendMessage'],
      resources: [ingestDeadLetterQueue.queueArn],
      // Both must fail for the deny to apply: the subscriber delivers either
      // as the service on its own behalf or with its delivery role.
      conditions: {
        ArnNotLike: { 'aws:SourceArn': subscriberArnPattern },
        ArnNotEquals: { 'aws:PrincipalArn': roles.subscriber.roleArn },
      },
    }),
  );

  roles.subscriber.addToPolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecordBatch', 'firehose:PutRecord'], resources: [stream.attrArn] }));
  ingestDeadLetterQueue.grantSendMessages(roles.subscriber);

  const ingestSubscriber = new eventsv2.CfnSubscriber(scope, 'IngestSubscriber', {
    name: names.ingestSubscriberName,
    eventBusArn: ingestBus.attrEventBusArn,
    description: 'tenant-usage-metering: ingest bus to Firehose (ADR-0002)',
    type: 'UNORDERED',
    batchConfiguration: { maxBatchSize: 500, maxBatchWindowInSeconds: 5 },
    // The age bounds the retries: the attempt count is set to its maximum,
    // because its default (5) would end them long before 24 hours.
    retryPolicy: { maxEventAgeInSeconds: SUBSCRIBER_MAX_EVENT_AGE.toSeconds(), maxRetryAttempts: SUBSCRIBER_MAX_RETRY_ATTEMPTS },
    onFailureConfiguration: { arn: ingestDeadLetterQueue.queueArn },
  });
  // aws-cdk-lib 2.274.0's L1 lacks `InvokeConfiguration`, which the resource
  // type requires (AWS::EventsV2::Subscriber); set it as a raw property.
  ingestSubscriber.addPropertyOverride('InvokeConfiguration', {
    TargetArn: stream.attrArn,
    RoleArn: roles.subscriber.roleArn,
  });
  ingestSubscriber.node.addDependency(roles.subscriber);

  return {
    ingestBus,
    ingestSubscriber,
    ingestDeadLetterQueue,
    usageBus,
    stream,
    ingestBusArn: ingestBus.attrEventBusArn,
    usageBusArn: usageBus.attrEventBusArn,
  };
}
