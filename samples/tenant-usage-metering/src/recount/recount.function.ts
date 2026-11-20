// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda task of the recounter state machine (spec §3.1): `count` runs one
 * recount; `fail`, on the state machine's catch path, marks the hour
 * `COUNT_FAILED` if the execution still holds its lease. The lease is the
 * execution's name, unique per execution.
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Recount, type ObjectStore, type RecountOutcome } from './count';
import { documentClient } from '../shared/db';
import { ENV, requireEnv, requireIntEnv } from '../shared/env';
import { Metrics } from '../shared/metrics';
import { isHourKey } from '../shared/time';

export interface RecountTask {
  readonly step: 'count' | 'fail';
  readonly hour: string;
  readonly lease: string;
}

export function s3ObjectStore(s3: S3Client, bucket: string): ObjectStore {
  return {
    list: async (prefix) => {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        out.push(...(page.Contents ?? []).map((object) => object.Key!).filter((key) => key !== undefined));
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return out;
    },
    read: async (key) => {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return (await object.Body?.transformToString('utf8')) ?? '';
    },
  };
}

export const handler = async (task: RecountTask): Promise<{ outcome: RecountOutcome | 'FAILED' }> => {
  if (!isHourKey(task.hour) || typeof task.lease !== 'string' || task.lease.length === 0) {
    throw new Error('bad recount task');
  }
  const metrics = new Metrics();
  try {
    const recount = new Recount({
      db: documentClient(),
      tableName: requireEnv(ENV.tableName),
      objects: s3ObjectStore(new S3Client({}), requireEnv(ENV.rawBucket)),
      lateGraceMinutes: requireIntEnv(ENV.lateGraceMinutes),
      metrics,
    });
    if (task.step === 'fail') {
      await recount.fail(task.hour, task.lease);
      return { outcome: 'FAILED' };
    }
    return { outcome: await recount.run(task.hour, task.lease) };
  } finally {
    metrics.flush();
  }
};
