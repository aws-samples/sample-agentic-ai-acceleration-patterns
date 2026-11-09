// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The construct's alarms (M-24, M-25, ADR-0002, ADR-0010). The deployer
 * routes them to an on-call target (no action is attached here).
 *
 * - `KeyBindingChanged`: the registry watch's metric, raised on a `MODIFY`
 *   that changes a binding or on a re-onboarding within the tombstone's 7
 *   days. Detected, not prevented (spec §7.1).
 * - `PutKeyPolicy`: reading a tenant's documents as an administrator, or
 *   adding a consumer, takes `kms:PutKeyPolicy` on that tenant's key, which
 *   is the residual of the key-policy binding (spec §7.2). A rule on the
 *   default bus matches the CloudTrail management event and sends it to an
 *   SQS audit queue; the alarm watches the rule's `TriggeredRules` metric
 *   (ADR-0016).
 *   CloudTrail management events reach EventBridge from the account's
 *   CloudTrail; the README names this as a prerequisite.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { BINDING_CHANGE_METRIC, METRICS_NAMESPACE } from '../shared/constants';

export interface IngestionAlarms {
  readonly bindingChanged: cloudwatch.Alarm;
  readonly putKeyPolicy: cloudwatch.Alarm;
  readonly putKeyPolicyRule: events.Rule;
  readonly auditQueue: sqs.Queue;
}

/** The CloudTrail event pattern of `kms:PutKeyPolicy` (M-25). */
export const PUT_KEY_POLICY_PATTERN: events.EventPattern = {
  source: ['aws.kms'],
  detailType: ['AWS API Call via CloudTrail'],
  detail: { eventSource: ['kms.amazonaws.com'], eventName: ['PutKeyPolicy'] },
};

export function createAlarms(scope: Construct, props: { logRetention: logs.RetentionDays }): IngestionAlarms {
  const bindingChanged = new cloudwatch.Alarm(scope, 'KeyBindingChangedAlarm', {
    alarmDescription: 'tenant-encrypted-ingestion: a tenant key binding changed, or a removed tenant reappeared within 7 days (M-24)',
    metric: new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName: BINDING_CHANGE_METRIC, statistic: 'Sum', period: Duration.minutes(5) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  // The matched events are kept 14 days for the operator who answers the alarm.
  const auditQueue = new sqs.Queue(scope, 'KeyPolicyAuditQueue', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
    removalPolicy: RemovalPolicy.DESTROY,
  });
  const putKeyPolicyRule = new events.Rule(scope, 'PutKeyPolicyRule', {
    description: 'tenant-encrypted-ingestion: kms:PutKeyPolicy in this account (M-25)',
    eventPattern: PUT_KEY_POLICY_PATTERN,
    targets: [new targets.SqsQueue(auditQueue)],
  });
  const putKeyPolicy = new cloudwatch.Alarm(scope, 'PutKeyPolicyAlarm', {
    alarmDescription: 'tenant-encrypted-ingestion: kms:PutKeyPolicy was called; a tenant key policy may have changed (M-25)',
    metric: new cloudwatch.Metric({
      namespace: 'AWS/Events',
      metricName: 'TriggeredRules',
      dimensionsMap: { RuleName: putKeyPolicyRule.ruleName },
      statistic: 'Sum',
      period: Duration.minutes(5),
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  return { bindingChanged, putKeyPolicy, putKeyPolicyRule, auditQueue };
}
