// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingestion bucket and its settings (spec §3.1, §7.4; M-8, M-31). The
 * policy statements are in src/construct/bucket-policy.ts.
 *
 * - `BucketOwnerEnforced`, Block Public Access, TLS only.
 * - Versioning on: a processed drop is removed by deleting the exact version
 *   read, and the sweep's ability to overwrite a landed document is
 *   recoverable for 7 days.
 * - `ingest/`: noncurrent versions expire after 1 day, expired delete
 *   markers are removed, current drops expire after `dropRetentionDays`,
 *   incomplete multipart uploads are aborted after 1 day (two rules: S3
 *   refuses `ExpiredObjectDeleteMarker` beside an expiration in days).
 * - `documents/`: noncurrent versions after 7 days.
 * - Default encryption SSE-S3 with Bucket Keys OFF. Every write the bucket
 *   accepts is SSE-KMS with the tenant's key (the policy refuses anything
 *   else); the default is never used, and a bucket key would put the bucket
 *   ARN in the KMS context and break the prefix binding (spec §7.2).
 * - EventBridge notifications on (`Object Created` reaches the default bus).
 * - Server access logs to the separate access-log bucket.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { DOCUMENTS_PREFIX, INGEST_PREFIX } from '../shared/constants';

export interface IngestionBucketProps {
  /** Unset only for the integration test's scratch bucket. */
  readonly accessLogBucket?: s3.IBucket;
  readonly dropRetentionDays: number;
}

export function createIngestionBucket(scope: Construct, id: string, props: IngestionBucketProps): s3.Bucket {
  return new s3.Bucket(scope, id, {
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    bucketKeyEnabled: false,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    enforceSSL: true,
    eventBridgeEnabled: true,
    serverAccessLogsBucket: props.accessLogBucket,
    serverAccessLogsPrefix: props.accessLogBucket === undefined ? undefined : 'ingestion/',
    removalPolicy: RemovalPolicy.DESTROY, // sample only
    autoDeleteObjects: true,
    lifecycleRules: [
      {
        id: 'IngestDropsAndVersions',
        prefix: INGEST_PREFIX,
        expiration: Duration.days(props.dropRetentionDays),
        noncurrentVersionExpiration: Duration.days(1),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      },
      { id: 'IngestDeleteMarkers', prefix: INGEST_PREFIX, expiredObjectDeleteMarker: true },
      { id: 'DocumentsNoncurrentVersions', prefix: DOCUMENTS_PREFIX, noncurrentVersionExpiration: Duration.days(7) },
    ],
  });
}
