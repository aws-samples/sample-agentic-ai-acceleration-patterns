// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The access-log bucket (spec §7.4, N-6, M-27). S3 server access logs of
 * the ingestion bucket hold presigned query strings with their signatures,
 * so this bucket Denies `s3:GetObject` to every principal but
 * `accessLogReaderRole` (an Allow alone would be filtered: any identity
 * policy in the account could read). With no reader role, nobody can read
 * the logs until the deployer names one. SSE-S3 (a KMS key would need the
 * logging service in its policy), `DESTROY` with auto-delete, and objects
 * expire after `dropRetentionDays` plus 30 days.
 */

import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface AccessLogBucketProps {
  readonly dropRetentionDays: number;
  readonly readerRole?: iam.IRole;
}

export function createAccessLogBucket(scope: Construct, id: string, props: AccessLogBucketProps): s3.Bucket {
  const bucket = new s3.Bucket(scope, id, {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
    autoDeleteObjects: true,
    lifecycleRules: [{ id: 'ExpireAccessLogs', expiration: Duration.days(props.dropRetentionDays + 30) }],
  });
  bucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyReadExceptAccessLogReader',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [bucket.arnForObjects('*')],
      ...(props.readerRole !== undefined ? { conditions: { ArnNotEquals: { 'aws:PrincipalArn': props.readerRole.roleArn } } } : {}),
    }),
  );
  Validations.of(bucket).acknowledge({
    id: 'AwsSolutions-S1',
    reason: 'This is the access-log bucket of the ingestion bucket; logging it to itself would loop (M-27).',
  });
  return bucket;
}
