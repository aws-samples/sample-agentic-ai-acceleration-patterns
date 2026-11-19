// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `UsageSubscriber` (spec §6.3, ADR-0006): attaches a reader to the ingest
 * bus (`raw`, checked usage events) or the usage bus (`usage`,
 * `UsageRecorded` records), in the metering account or in an account the
 * bus is shared with.
 *
 * It always creates an SQS dead-letter queue (SSE, 14-day retention) and
 * two alarms, on the queue's depth and on events reaching it, and exposes
 * the queue. There is no prop to turn either off: a reader that bills from
 * these streams must see every event or know which it missed (spec §6.2
 * item 7).
 *
 * `meters` and `tenants` filter on the record's `meterId` and `tenantId`,
 * under `detail` in the envelope EventBridge matches.
 * They are a convenience, not a boundary: an account a bus is shared with
 * can create an unfiltered subscriber (spec §3.2).
 */

import { Duration, Names, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as eventsv2 from 'aws-cdk-lib/aws-eventsv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export type UsageStream = 'raw' | 'usage';

export interface UsageSubscriberProps {
  /** The ingest or usage bus ARN, from the published parameter. */
  readonly busArn: string;
  /** `raw` (checked usage events) or `usage` (`UsageRecorded` records). @default 'usage' */
  readonly stream?: UsageStream;
  /** Any target the bus supports. */
  readonly targetArn: string;
  /** The role the bus delivers with; this construct adds its trust and its dead-letter grant. */
  readonly role: iam.Role;
  /** Only these meters. @default all */
  readonly meters?: string[];
  /** Only these tenants. @default all */
  readonly tenants?: string[];
  /** `UNORDERED`, or `FIFO` per tenant. @default 'UNORDERED' */
  readonly type?: 'UNORDERED' | 'FIFO';
  /** Where delivery starts: `LATEST`, or a point in time inside the bus's retention. @default 'LATEST' */
  readonly startingPosition?: 'LATEST' | Date;
  /** How long a failing event is retried before it goes to the dead-letter queue, 1 minute to 24 hours. @default 24 hours */
  readonly maxEventAge?: Duration;
  /** SNS topic for the alarms. @default none */
  readonly alarmTopic?: sns.ITopic;
}

/**
 * The payload filter of a subscriber, or none. Each bus carries one kind of
 * event, so only the meter and tenant lists filter.
 */
export function subscriberFilters(meters: string[] | undefined, tenants: string[] | undefined): eventsv2.CfnSubscriber.FilterProperty[] {
  const data: Record<string, string[]> = {};
  if (meters !== undefined && meters.length > 0) {
    data.meterId = [...meters];
  }
  if (tenants !== undefined && tenants.length > 0) {
    data.tenantId = [...tenants];
  }
  // For PutEvents, DATA is the EventBridge envelope and the record is under
  // `detail` (EventBridge user guide, "Filtering events for a subscriber").
  // A pattern on the top-level fields matched nothing (test account, 2026-11-19).
  return Object.keys(data).length > 0 ? [{ scope: 'DATA', pattern: JSON.stringify({ detail: data }) }] : [];
}

export class UsageSubscriber extends Construct {
  public readonly subscriber: eventsv2.CfnSubscriber;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: UsageSubscriberProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const stream = props.stream ?? 'usage';
    const maxEventAge = props.maxEventAge ?? Duration.hours(24);
    if (!maxEventAge.isUnresolved() && (maxEventAge.toSeconds() < 60 || maxEventAge.toSeconds() > 86_400)) {
      throw new Error('maxEventAge must be from 1 minute to 24 hours');
    }
    for (const [name, values, pattern] of [
      ['meters', props.meters, /^[a-z0-9_.-]{1,64}$/],
      ['tenants', props.tenants, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/],
    ] as const) {
      for (const value of values ?? []) {
        if (!pattern.test(value)) {
          throw new Error(`${name} holds ${JSON.stringify(value)}, outside its charset`);
        }
      }
    }

    const name = Names.uniqueResourceName(this, { maxLength: 64, separator: '-' });
    const subscriberArns = stack.formatArn({ service: 'events', resource: 'subscriber', resourceName: `${name}/*` });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(this.deadLetterQueue).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is the subscriber dead-letter queue itself, with an alarm on its depth (ADR-0006).',
    });
    this.deadLetterQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowThisSubscriber',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [this.deadLetterQueue.queueArn],
        conditions: { ArnLike: { 'aws:SourceArn': subscriberArns }, StringEquals: { 'aws:SourceAccount': stack.account } },
      }),
    );
    this.deadLetterQueue.grantSendMessages(props.role);
    props.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        conditions: { StringEquals: { 'aws:SourceAccount': stack.account }, ArnLike: { 'aws:SourceArn': subscriberArns } },
      }),
    );

    const start = props.startingPosition ?? 'LATEST';
    const filters = subscriberFilters(props.meters, props.tenants);
    this.subscriber = new eventsv2.CfnSubscriber(this, 'Resource', {
      name,
      eventBusArn: props.busArn,
      description: `tenant-usage-metering ${stream} reader`,
      type: props.type ?? 'UNORDERED',
      ...(filters.length > 0 ? { filterConfiguration: { filters } } : {}),
      retryPolicy: { maxEventAgeInSeconds: maxEventAge.toSeconds(), maxRetryAttempts: 185 },
      onFailureConfiguration: { arn: this.deadLetterQueue.queueArn },
      ...(start === 'LATEST'
        ? { startingPosition: 'LATEST' }
        : {
          startingPosition: 'POINT_IN_TIME',
          pointInTimeConfiguration: { pointType: 'TIMESTAMP', startingPoint: Math.floor(start.getTime() / 1000) },
        }),
    });
    // aws-cdk-lib 2.274.0's L1 lacks `InvokeConfiguration` (see pipeline.ts).
    this.subscriber.addPropertyOverride('InvokeConfiguration', { TargetArn: props.targetArn, RoleArn: props.role.roleArn });
    this.subscriber.node.addDependency(props.role);

    const depth = this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' });
    const arrived = this.deadLetterQueue.metricNumberOfMessagesSent({ period: Duration.minutes(5), statistic: 'Sum' });
    this.alarms = [
      depth.createAlarm(this, 'DeadLetterDepthAlarm', {
        alarmDescription: `tenant-usage-metering ${stream} reader: events wait in the dead-letter queue`,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      arrived.createAlarm(this, 'FailedDeliveryAlarm', {
        alarmDescription: `tenant-usage-metering ${stream} reader: an event could not be delivered`,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    if (props.alarmTopic !== undefined) {
      for (const alarm of this.alarms) {
        alarm.addAlarmAction(new actions.SnsAction(props.alarmTopic));
      }
    }
  }
}
