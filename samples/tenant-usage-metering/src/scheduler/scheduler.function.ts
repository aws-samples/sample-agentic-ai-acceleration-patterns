// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** Lambda entry of the scheduler, started by EventBridge Scheduler every 5 minutes (spec §3.1). */

import { SFNClient } from '@aws-sdk/client-sfn';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Scheduler } from './scheduler';
import { documentClient } from '../shared/db';
import { ENV, requireEnv, requireIntEnv } from '../shared/env';
import { Metrics } from '../shared/metrics';

export const handler = async (): Promise<void> => {
  const metrics = new Metrics();
  try {
    await new Scheduler({
      db: documentClient(),
      tableName: requireEnv(ENV.tableName),
      sfn: new SFNClient({}),
      recounterArn: requireEnv(ENV.recounterArn),
      sqs: new SQSClient({}),
      trackerFailureQueueUrl: requireEnv(ENV.trackerFailureQueueUrl),
      lateGraceMinutes: requireIntEnv(ENV.lateGraceMinutes),
      recountWindowHours: requireIntEnv(ENV.recountWindowHours),
      metrics,
    }).run();
  } finally {
    metrics.flush();
  }
};
