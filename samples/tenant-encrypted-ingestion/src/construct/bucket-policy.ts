// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The ingestion bucket's policy (spec §7.4, P-3, P-7, P-8; ADR-0002,
 * ADR-0006; M-7, M-8). It repeats the role asymmetry from the resource side,
 * so an identity policy in the vendor account that grants S3 widely still
 * meets these Denies:
 *
 * - TLS only (from `enforceSSL`, src/construct/bucket.ts).
 * - `PutObject` only with `x-amz-server-side-encryption: aws:kms` (a negated
 *   operator on an absent key is true, so a missing header is caught).
 * - `PutObject` on `ingest/*` only with `If-None-Match` (write once; this
 *   also refuses multipart there). Scoped to `ingest/*`: a `CopyObject`
 *   into an enforced prefix would fail.
 * - `PutObject` on `ingest/*` with a storage class other than `STANDARD`,
 *   or with any website redirect, is denied (unsigned headers could
 *   otherwise park a drop where the processor cannot read it).
 * - Principal-scoped writes and deletes, by role ARN on `aws:PrincipalArn`:
 *   `PutObject` on `ingest/*` only by a tenant role, on `documents/*` only
 *   by `tenantProcessRole`; deletes on `ingest/*` only by
 *   `tenantProcessRole`, `tenantPlatformRole` or the auto-delete provider's
 *   role, on `documents/*` only by `tenantPlatformRole` or that role. CDK
 *   makes the auto-delete provider depend on this policy, so without the
 *   exemption `cdk destroy` could not empty the versioned bucket.
 * - Any request whose signature is older than
 *   `max(uploadUrlTtlSeconds, validatorObjectUrlTtlSeconds)`: code cannot
 *   presign longer than configured (`X-Amz-Expires` ends a URL).
 */

import { CustomResourceProviderBase, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { TenantRoles } from './roles';
import { DOCUMENTS_PREFIX, INGEST_PREFIX } from '../shared/constants';

export const AUTO_DELETE_PROVIDER_ID = 'Custom::S3AutoDeleteObjectsCustomResourceProvider';

/** The stack singleton role that empties auto-delete buckets. Call after the bucket exists. */
export function autoDeleteProviderRoleArn(scope: s3.IBucket): string {
  const provider = Stack.of(scope).node.tryFindChild(AUTO_DELETE_PROVIDER_ID) as CustomResourceProviderBase | undefined;
  if (provider === undefined) {
    throw new Error('the S3 auto-delete provider is missing: create the bucket with autoDeleteObjects first');
  }
  return provider.roleArn;
}

export interface IngestionBucketPolicyProps {
  /** Unset: the principal-scoped statements are left out (the integration test's scratch bucket, M-32). */
  readonly tenantRoles?: TenantRoles;
  readonly maxSignatureAgeSeconds: number;
}

export function addIngestionBucketPolicy(bucket: s3.Bucket, props: IngestionBucketPolicyProps): void {
  const ingest = bucket.arnForObjects(`${INGEST_PREFIX}*`);
  const documents = bucket.arnForObjects(`${DOCUMENTS_PREFIX}*`);
  const deny = (sid: string, actions: string[], resources: string[], conditions: Record<string, Record<string, unknown>>) =>
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions, resources, conditions }),
    );

  deny('DenyPutWithoutSseKms', ['s3:PutObject'], [bucket.arnForObjects('*')], {
    StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
  });
  deny('DenyDropWithoutIfNoneMatch', ['s3:PutObject'], [ingest], { Null: { 's3:if-none-match': 'true' } });
  deny('DenyDropNonStandardStorageClass', ['s3:PutObject'], [ingest], {
    StringNotEquals: { 's3:x-amz-storage-class': 'STANDARD' },
    Null: { 's3:x-amz-storage-class': 'false' },
  });
  deny('DenyDropWebsiteRedirect', ['s3:PutObject'], [ingest], { Null: { 's3:x-amz-website-redirect-location': 'false' } });
  deny('DenyOldSignatures', ['s3:*'], [bucket.bucketArn, bucket.arnForObjects('*')], {
    NumericGreaterThan: { 's3:signatureAge': props.maxSignatureAgeSeconds * 1000 },
  });
  if (props.tenantRoles === undefined) {
    return;
  }
  const autoDelete = autoDeleteProviderRoleArn(bucket);
  const { upload, process, platform } = props.tenantRoles;
  deny('DenyDropWriteExceptTenantRoles', ['s3:PutObject'], [ingest], {
    ArnNotEquals: { 'aws:PrincipalArn': [upload.roleArn, process.roleArn, platform.roleArn] },
  });
  deny('DenyDocumentWriteExceptProcessRole', ['s3:PutObject'], [documents], { ArnNotEquals: { 'aws:PrincipalArn': [process.roleArn] } });
  deny('DenyDropDeleteExceptProcessPlatformAutoDelete', ['s3:DeleteObject', 's3:DeleteObjectVersion'], [ingest], {
    ArnNotEquals: { 'aws:PrincipalArn': [process.roleArn, platform.roleArn, autoDelete] },
  });
  deny('DenyDocumentDeleteExceptPlatformAutoDelete', ['s3:DeleteObject', 's3:DeleteObjectVersion'], [documents], {
    ArnNotEquals: { 'aws:PrincipalArn': [platform.roleArn, autoDelete] },
  });
}
