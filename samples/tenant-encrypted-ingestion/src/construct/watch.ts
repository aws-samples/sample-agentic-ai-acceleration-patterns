// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The registry watch wiring (spec §7.1, M-24, M-31): the stream function
 * behind an event-source filter `SK = KEY`, so delivery rows never invoke
 * it, with bisect-on-error, three retries and an SQS on-failure destination
 * (SSE-SQS). The failure queue holds stream record pointers, never images.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { createFunction, type FunctionWithLogs } from './functions';
import { KEY_SK } from '../shared/registry';

/** The event-source filter: key rows only. */
export const WATCH_FILTER = lambda.FilterCriteria.filter({ dynamodb: { Keys: { SK: { S: lambda.FilterRule.isEqual(KEY_SK) } } } });

export function createWatchFailureQueue(scope: Construct): sqs.Queue {
  return new sqs.Queue(scope, 'WatchFailureQueue', {
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

export interface WatchProps {
  readonly role: iam.Role;
  readonly table: dynamodb.ITable;
  readonly failureQueue: sqs.IQueue;
  readonly environment: Record<string, string>;
  readonly logRetention: logs.RetentionDays;
}

export function createWatch(scope: Construct, props: WatchProps): FunctionWithLogs {
  const watch = createFunction(scope, 'RegistryWatchFunction', {
    entry: 'registry-watch/handler.ts',
    role: props.role,
    timeout: Duration.seconds(30),
    environment: props.environment,
    logRetention: props.logRetention,
    description: 'tenant-encrypted-ingestion registry watch: alarms on a changed binding or a reappearing tenant (M-24)',
  });
  watch.fn.addEventSource(
    new DynamoEventSource(props.table, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 3,
      onFailure: new SqsDlq(props.failureQueue),
      filters: [WATCH_FILTER],
    }),
  );
  return watch;
}
