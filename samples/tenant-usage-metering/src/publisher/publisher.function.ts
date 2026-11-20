// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the record publisher: the table's stream (filtered to
 * usage records holding a marker), and `{ "sweep": true }` from its own
 * 5-minute schedule (spec §3.1, §4.7). Stream failures are reported per
 * record, so one bad record does not hold back the batch.
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { EventBridgeV2Client } from '@aws-sdk/client-eventbridgev2';
import { SQSClient } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { markerArrived, Publisher } from './publisher';
import { documentClient } from '../shared/db';
import { ENV, requireEnv } from '../shared/env';
import type { UsageRecordItem } from '../shared/items';
import { errorName, log } from '../shared/logger';
import { Metrics } from '../shared/metrics';

let publisher: Publisher | undefined;
let metrics: Metrics | undefined;

function instance(): { publisher: Publisher; metrics: Metrics } {
  metrics ??= new Metrics();
  publisher ??= new Publisher({
    db: documentClient(),
    tableName: requireEnv(ENV.tableName),
    eventBridge: new EventBridgeV2Client({}),
    usageBusArn: requireEnv(ENV.usageBusArn),
    sqs: new SQSClient({}),
    deliveryQueueUrl: requireEnv(ENV.deliveryQueueUrl),
    metrics,
  });
  return { publisher, metrics };
}

export const handler = async (event: DynamoDBStreamEvent | { sweep: true }): Promise<DynamoDBBatchResponse | { swept: number }> => {
  const { publisher: p, metrics: m } = instance();
  try {
    if ('sweep' in event) {
      return { swept: await p.sweep() };
    }
    const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records ?? []) {
      const image = (raw: unknown) =>
        raw === undefined ? undefined : (unmarshall(raw as Record<string, AttributeValue>) as Partial<UsageRecordItem>);
      const newImage = image(record.dynamodb?.NewImage);
      if (!markerArrived(newImage, image(record.dynamodb?.OldImage))) {
        continue;
      }
      try {
        await p.publish(newImage as UsageRecordItem);
      } catch (error) {
        log.error('record not published', { errorType: errorName(error) });
        batchItemFailures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? '' });
        // Records of one key must stay in order: stop at the first failure.
        break;
      }
    }
    return { batchItemFailures };
  } finally {
    m.flush();
  }
};
