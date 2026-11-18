// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Every alarm the specification names (spec §3.1, §3.2, §3.5, §4.5, §4.7),
 * each sent to `alarmTopicArn` when one is given.
 */

import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { Compute } from './compute';
import type { Pipeline } from './pipeline';
import { METRIC } from '../shared/metrics';

export interface AlarmProps {
  readonly compute: Compute;
  readonly pipeline: Pipeline;
  readonly namespace: string;
  readonly alarmTopicArn?: string;
}

export function createAlarms(scope: Construct, props: AlarmProps): cloudwatch.Alarm[] {
  const topic = props.alarmTopicArn === undefined ? undefined : sns.Topic.fromTopicArn(scope, 'AlarmTopic', props.alarmTopicArn);
  const alarms: cloudwatch.Alarm[] = [];
  const add = (
    id: string,
    metric: cloudwatch.Metric | cloudwatch.MathExpression,
    description: string,
    options: Partial<cloudwatch.CreateAlarmOptions> = {},
  ) => {
    const alarm = metric.createAlarm(scope, id, {
      alarmDescription: `tenant-usage-metering: ${description}`,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      ...options,
    });
    if (topic !== undefined) {
      alarm.addAlarmAction(new actions.SnsAction(topic));
    }
    alarms.push(alarm);
  };
  const custom = (name: string, period = Duration.minutes(5)) =>
    new cloudwatch.Metric({ namespace: props.namespace, metricName: name, statistic: 'Sum', period });
  const depth = (queue: sqs.IQueue) =>
    queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' });

  add('UnregisteredCallerAlarm', custom(METRIC.unregisteredCaller), 'calls from roles that are not registered emitters (spec §3.2)');
  add('RefusalsNotStoredAlarm', custom(METRIC.droppedRefusals), 'refusals over the per-emitter cap were counted, not stored (spec §3.2)');
  add(
    'FirehoseErrorObjectAlarm',
    custom(METRIC.firehoseErrorObject),
    'Firehose wrote an object under firehose-error/, which the recount does not read (spec §3.1)',
  );
  add('ObjectInClosedHourAlarm', custom(METRIC.objectInClosedHour), 'an object landed in a CLOSED hour (spec §4.5)');
  add('HourPastCloseAlarm', custom(METRIC.hourPastCloseNotCounted), 'an hour reached its close time without being COUNTED (spec §4.5)');
  add('RecountFailedThriceAlarm', custom(METRIC.recountFailedThrice), 'an hour failed to count three times in a row (spec §4.5)');
  add(
    'MalformedStoredEventAlarm',
    custom(METRIC.malformedStoredEvent),
    'the recount skipped stored values that are not enriched events of their hour',
  );
  add('DeliveriesFailedAlarm', custom(METRIC.deliveryFailed), 'a sink delivery is FAILED (spec §4.7)');
  add('DeliveriesBlockedAlarm', custom(METRIC.deliveryBlocked), 'a sink delivery is BLOCKED for want of a billing account (spec §4.7)');
  add(
    'RecountTimedOutAlarm',
    props.compute.recounter.metricTimedOut({ period: Duration.minutes(5) }),
    'a recounter execution timed out (spec §4.5)',
  );
  add(
    'TrackerFailuresAlarm',
    depth(props.compute.trackerFailureQueue),
    'object tracker failures waited 15 minutes for a replay (spec §4.5)',
    { evaluationPeriods: 3 },
  );
  add('PublisherFailuresAlarm', depth(props.compute.publisherFailureQueue), 'a record publisher stream batch failed (spec §3.1)');
  add('DeliveryDeadLetterAlarm', depth(props.compute.deliveryDeadLetterQueue), 'a delivery was received 200 times without being settled');
  if (props.pipeline.ingestDeadLetterQueue !== undefined) {
    add(
      'IngestDeadLetterAlarm',
      depth(props.pipeline.ingestDeadLetterQueue),
      'checked events reached the ingest dead-letter queue; run StartIngestRedrive (spec §6.2 item 8)',
    );
  }

  // Heartbeat (spec §3.5): the scheduler stopped, or hours wait past their grace and none gets counted.
  add(
    'SchedulerHeartbeatAlarm',
    props.compute.schedulerFn.metricInvocations({ period: Duration.minutes(5), statistic: 'Sum' }),
    'the scheduler has not run for 15 minutes (spec §3.5)',
    {
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    },
  );
  add(
    'CountingStalledAlarm',
    new cloudwatch.MathExpression({
      expression: 'IF(pastGrace > 0 AND FILL(counted, 0) == 0, 1, 0)',
      usingMetrics: { pastGrace: custom(METRIC.hoursPastGrace, Duration.hours(2)), counted: custom(METRIC.hourCounted, Duration.hours(2)) },
      period: Duration.hours(2),
    }),
    'no hour reached COUNTED for 2 hours while hours wait past their grace (spec §3.5)',
  );
  return alarms;
}
