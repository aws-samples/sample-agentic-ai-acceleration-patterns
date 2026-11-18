// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The raw bucket, the export bucket and their access-log bucket (spec §3.5,
 * T-24, M-24, T-27).
 *
 * Both data buckets carry explicit-deny statements with `aws:PrincipalArn`
 * conditions, so an identity-policy allow anywhere in the account does not
 * get around them: each prefix is written only by its pipeline role, objects
 * are deleted only by the stack's auto-delete-objects provider (on stack
 * delete) and by lifecycle, and lifecycle, versioning, policy and
 * notification changes are left to the deployment role and the providers
 * CloudFormation runs. Versioning keeps an overwritten object for audit;
 * noncurrent versions expire 7 days after their current version.
 */

import { CustomResourceProviderBase, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { ResolvedProps } from './props';
import type { ServiceRoles } from './roles';

/** Prefixes of the raw bucket (spec §4.8). */
export const RAW_PREFIX = 'raw/';
export const READMITTED_PREFIX = 'readmitted/';
export const ERROR_PREFIX = 'error/';
export const FIREHOSE_ERROR_PREFIX = 'firehose-error/';

/** Noncurrent versions are kept this long after they stop being current. */
const NONCURRENT_DAYS = 7;

/** The bucket configuration actions only CloudFormation's roles may call. */
const CONFIGURATION_ACTIONS = [
  's3:PutLifecycleConfiguration',
  's3:PutBucketVersioning',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutBucketNotification',
];

export interface Storage {
  readonly rawBucket: s3.Bucket;
  readonly exportBucket: s3.Bucket;
  readonly accessLogBucket: s3.Bucket;
  /** The role the configuration denies exempt, besides the providers. */
  readonly deploymentRoleArn: string;
}

/** The bootstrap `cfn-exec` role of this stack's synthesizer (spec §3.3). */
export function defaultDeploymentRoleArn(scope: Construct): string {
  const stack = Stack.of(scope);
  const qualifier = (scope.node.tryGetContext('@aws-cdk/core:bootstrapQualifier') as string | undefined) ?? 'hnb659fds';
  return stack.formatArn({
    service: 'iam',
    region: '',
    resource: 'role',
    resourceName: `cdk-${qualifier}-cfn-exec-role-${stack.account}-${stack.region}`,
  });
}

function autoDeleteProviderRoleArn(scope: Construct): string {
  const provider = Stack.of(scope).node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider');
  if (!(provider instanceof CustomResourceProviderBase)) {
    throw new Error('the S3 auto-delete-objects provider was not found; create the buckets with autoDeleteObjects first');
  }
  return provider.roleArn;
}

function deny(sid: string, actions: string[], resources: string[], allowedArns: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions,
    resources,
    conditions: { ArnNotEquals: { 'aws:PrincipalArn': allowedArns } },
  });
}

function dataBucket(scope: Construct, id: string, accessLogBucket: s3.Bucket, lifecycleRules: s3.LifecycleRule[]): s3.Bucket {
  return new s3.Bucket(scope, id, {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    enforceSSL: true,
    versioned: true,
    serverAccessLogsBucket: accessLogBucket,
    serverAccessLogsPrefix: `${id}/`,
    removalPolicy: RemovalPolicy.DESTROY, // sample only (standard §4.3)
    autoDeleteObjects: true,
    lifecycleRules: [
      ...lifecycleRules,
      { id: 'RemoveExpiredDeleteMarkers', expiredObjectDeleteMarker: true, abortIncompleteMultipartUploadAfter: Duration.days(1) },
    ],
  });
}

const expire = (id: string, prefix: string | undefined, days: number): s3.LifecycleRule => ({
  id,
  ...(prefix !== undefined ? { prefix } : {}),
  expiration: Duration.days(days),
  noncurrentVersionExpiration: Duration.days(NONCURRENT_DAYS),
});

export function createStorage(scope: Construct, props: ResolvedProps, roles: ServiceRoles): Storage {
  const accessLogBucket = new s3.Bucket(scope, 'AccessLogBucket', {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
    autoDeleteObjects: true,
    lifecycleRules: [{ id: 'ExpireAccessLogs', expiration: Duration.days(props.rawRetentionDays) }],
  });
  Validations.of(accessLogBucket).acknowledge({
    id: 'AwsSolutions-S1',
    reason: 'This is the access-log bucket of the raw and export buckets; logging it to itself would loop.',
  });

  const rawBucket = dataBucket(scope, 'RawBucket', accessLogBucket, [
    expire('ExpireRaw', RAW_PREFIX, props.rawRetentionDays),
    expire('ExpireReadmitted', READMITTED_PREFIX, props.rawRetentionDays),
    expire('ExpireFirehoseErrors', FIREHOSE_ERROR_PREFIX, props.rawRetentionDays),
    expire('ExpireErrors', ERROR_PREFIX, props.errorRetentionDays),
  ]);
  const exportBucket = dataBucket(scope, 'ExportBucket', accessLogBucket, [expire('ExpireExports', undefined, props.rawRetentionDays)]);

  const deploymentRoleArn = props.deploymentRoleArn ?? defaultDeploymentRoleArn(scope);
  const autoDelete = autoDeleteProviderRoleArn(scope);
  const objects = (bucket: s3.Bucket, prefix: string): string => bucket.arnForObjects(`${prefix}*`);

  for (const statement of [
    deny('DenyRawWritesExceptFirehose', ['s3:PutObject'], [objects(rawBucket, RAW_PREFIX), objects(rawBucket, FIREHOSE_ERROR_PREFIX)], [roles.firehose.roleArn]),
    deny('DenyReadmittedWritesExceptReadmission', ['s3:PutObject'], [objects(rawBucket, READMITTED_PREFIX)], [roles.readmission.roleArn]),
    deny('DenyErrorWritesExceptPipeline', ['s3:PutObject'], [objects(rawBucket, ERROR_PREFIX)], [roles.ingest.roleArn, roles.readmission.roleArn, roles.redrive.roleArn]),
    new iam.PolicyStatement({
      sid: 'DenyWritesOutsideThePrefixes',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      notResources: [RAW_PREFIX, READMITTED_PREFIX, ERROR_PREFIX, FIREHOSE_ERROR_PREFIX].map((prefix) => objects(rawBucket, prefix)),
    }),
    deny('DenyDeletesExceptAutoDelete', ['s3:DeleteObject', 's3:DeleteObjectVersion'], [rawBucket.arnForObjects('*')], [autoDelete]),
    deny('DenyConfigurationChanges', CONFIGURATION_ACTIONS, [rawBucket.bucketArn], [deploymentRoleArn, autoDelete]),
  ]) {
    rawBucket.addToResourcePolicy(statement);
  }

  for (const statement of [
    deny('DenyExportWritesExceptDispatcher', ['s3:PutObject'], [exportBucket.arnForObjects('*')], [roles.dispatcher.roleArn]),
    deny('DenyDeletesExceptAutoDelete', ['s3:DeleteObject', 's3:DeleteObjectVersion'], [exportBucket.arnForObjects('*')], [autoDelete]),
    deny('DenyConfigurationChanges', CONFIGURATION_ACTIONS, [exportBucket.bucketArn], [deploymentRoleArn, autoDelete]),
  ]) {
    exportBucket.addToResourcePolicy(statement);
  }

  return { rawBucket, exportBucket, accessLogBucket, deploymentRoleArn };
}
