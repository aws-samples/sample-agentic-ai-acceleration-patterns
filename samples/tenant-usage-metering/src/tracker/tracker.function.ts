// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the object tracker, invoked asynchronously by S3 event
 * notifications on `raw/` and `readmitted/` (spec §3.1). A thrown error is
 * retried by Lambda and then lands, with the S3 event, in the on-failure
 * queue the scheduler replays.
 */

import type { S3Event } from 'aws-lambda';
import { trackS3Event } from './track';
import { documentClient } from '../shared/db';
import { ENV, requireEnv } from '../shared/env';
import { Metrics } from '../shared/metrics';

export const handler = async (event: S3Event): Promise<void> => {
  const metrics = new Metrics();
  try {
    await trackS3Event(documentClient(), requireEnv(ENV.tableName), event, metrics);
  } finally {
    metrics.flush();
  }
};
