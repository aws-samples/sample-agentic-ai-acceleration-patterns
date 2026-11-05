// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Events in and out (spec §5.4, §7.7, ADR-0009, M-16, M-29).
 *
 * In: an `Object Created` rule on the DEFAULT bus, where S3 delivers, for
 * this construct's bucket and the `ingest/` prefix only, targeting the
 * pipeline queue with its own target DLQ.
 *
 * Out: the sample's own bus for `Delivery*` events. Its policy Denies
 * `events:PutEvents` unless `aws:PrincipalArn` is `processorRole` or
 * `sweepRole` (the sweep publishes the events of deliveries it terminates,
 * spec §8; §7.7 names only `processorRole`). The bus is vendor-side and
 * FILTERED for readers: any rule in the vendor's account sees every
 * tenant's events, so a consumer filters on `detail.tenantId`.
 */

import { Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { INGEST_PREFIX } from '../shared/constants';

export function createObjectCreatedRule(
  scope: Construct,
  props: { bucket: s3.IBucket; queue: sqs.IQueue; targetDeadLetterQueue: sqs.IQueue },
): events.Rule {
  return new events.Rule(scope, 'ObjectCreatedRule', {
    description: 'tenant-encrypted-ingestion: Object Created under ingest/ of this bucket -> pipeline queue (spec §8)',
    eventPattern: {
      source: ['aws.s3'],
      detailType: ['Object Created'],
      detail: {
        bucket: { name: [props.bucket.bucketName] },
        object: { key: [{ prefix: INGEST_PREFIX }] },
      },
    },
    targets: [
      new targets.SqsQueue(props.queue, {
        deadLetterQueue: props.targetDeadLetterQueue,
        retryAttempts: 185,
        maxEventAge: Duration.hours(24),
      }),
    ],
  });
}

export function createDeliveryBus(scope: Construct): events.EventBus {
  return new events.EventBus(scope, 'EventBus', {
    description: 'tenant-encrypted-ingestion: DeliveryAccepted | DeliveryRejected | DeliveryKeyUnavailable (spec §5.4)',
  });
}

export function addBusDeny(bus: events.EventBus, publishers: iam.IRole[]): void {
  bus.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyPutEventsExceptPipeline',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['events:PutEvents'],
      resources: [bus.eventBusArn],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': publishers.map((r) => r.roleArn) } },
    }),
  );
}
