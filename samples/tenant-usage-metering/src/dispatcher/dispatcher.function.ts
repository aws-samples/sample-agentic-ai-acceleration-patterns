// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the sink dispatcher, on the delivery queue (spec §3.1).
 * A delivery to retry stays on the queue with its visibility set to the
 * backoff, and is reported as a batch item failure so it is not deleted.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { Dispatcher, fetchSend } from './dispatcher';
import { sigV4Sign } from './sigv4';
import { documentClient } from '../shared/db';
import { ENV, requireEnv } from '../shared/env';
import type { DeliveryMessage } from '../shared/items';
import { errorName, log } from '../shared/logger';
import { Metrics } from '../shared/metrics';

const metrics = new Metrics();
let dispatcher: Dispatcher | undefined;
const sqs = new SQSClient({});

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  dispatcher ??= new Dispatcher({
    db: documentClient(),
    tableName: requireEnv(ENV.tableName),
    fleetName: requireEnv(ENV.fleetName),
    exportBucket: requireEnv(ENV.exportBucket),
    s3: new S3Client({}),
    secrets: new SecretsManagerClient({}),
    send: fetchSend,
    sign: sigV4Sign,
    metrics,
  });
  const queueUrl = requireEnv(ENV.deliveryQueueUrl);
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  try {
    for (const message of event.Records) {
      try {
        const delivery = JSON.parse(message.body) as DeliveryMessage;
        const result = await dispatcher.dispatch(delivery, Number(message.attributes.ApproximateReceiveCount ?? '1'));
        if (!result.done) {
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.receiptHandle,
              VisibilityTimeout: result.retryInSeconds,
            }),
          );
          batchItemFailures.push({ itemIdentifier: message.messageId });
        }
      } catch (error) {
        log.error('delivery not handled', { errorType: errorName(error) });
        batchItemFailures.push({ itemIdentifier: message.messageId });
      }
    }
  } finally {
    metrics.flush();
  }
  return { batchItemFailures };
};
