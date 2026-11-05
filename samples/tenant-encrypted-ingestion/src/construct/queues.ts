// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The pipeline queues and their policies (spec §7.7, ADR-0009, M-16, M-31).
 *
 * In one account an identity Allow reaches a queue, so an Allow-only queue
 * policy is filtered; these add explicit Denies.
 *
 * - Queue: Allow `sqs:SendMessage` to `events.amazonaws.com` from the rule
 *   (CDK's SqsQueue target writes it); Deny `sqs:SendMessage` unless
 *   `aws:SourceArn` is the rule or, when set, `aws:PrincipalArn` is
 *   `redriveOperatorRole`. Unset, only the rule sends and an operator
 *   redrive is not possible. Two conditions in one Deny are ANDed, which is
 *   exactly "unless A or B".
 * - DLQ: Deny `sqs:SendMessage` unless `aws:SourceArn` is the queue. Whether
 *   SQS's automatic move meets this is undocumented; spec §10 step 7b shows
 *   it, and the Deny is to be dropped if it blocks the move.
 * - EventBridge target DLQ: its own rule-only policy (CDK's target writes it).
 * - SSE-SQS everywhere; both DLQs keep messages 14 days (the uploader's IP
 *   address in S3 events is kept that long).
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface PipelineQueues {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly targetDeadLetterQueue: sqs.Queue;
}

const DLQ_RETENTION = Duration.days(14);

export function createPipelineQueues(scope: Construct, props: { visibilityTimeout: Duration; maxReceiveCount: number }): PipelineQueues {
  const common = { encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY };
  const deadLetterQueue = new sqs.Queue(scope, 'DeadLetterQueue', { ...common, retentionPeriod: DLQ_RETENTION });
  const targetDeadLetterQueue = new sqs.Queue(scope, 'TargetDeadLetterQueue', { ...common, retentionPeriod: DLQ_RETENTION });
  const queue = new sqs.Queue(scope, 'Queue', {
    ...common,
    visibilityTimeout: props.visibilityTimeout,
    retentionPeriod: Duration.days(4),
    deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: props.maxReceiveCount },
  });
  return { queue, deadLetterQueue, targetDeadLetterQueue };
}

export function addQueueDenies(queues: PipelineQueues, props: { ruleArn: string; redriveOperatorRole?: iam.IRole }): void {
  queues.queue.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenySendExceptRuleOrRedriveOperator',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sqs:SendMessage'],
      resources: [queues.queue.queueArn],
      conditions: {
        ArnNotEquals: {
          'aws:SourceArn': props.ruleArn,
          ...(props.redriveOperatorRole !== undefined ? { 'aws:PrincipalArn': props.redriveOperatorRole.roleArn } : {}),
        },
      },
    }),
  );
  queues.deadLetterQueue.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenySendExceptSourceQueue',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sqs:SendMessage'],
      resources: [queues.deadLetterQueue.queueArn],
      conditions: { ArnNotEquals: { 'aws:SourceArn': queues.queue.queueArn } },
    }),
  );
}
