// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The probe through S3 (spec P-5, §8 "Probe", ADR-0004, M-18, M-19).
 *
 * A key's usability can only be tested the way the pipeline uses it: the
 * key policy requires `kms:ViaService = s3`, so a direct KMS call proves
 * nothing, and `DescribeKey` cannot tell a removed use statement from a
 * healthy key. The probe writes, reads and deletes one small object,
 * `ingest/<t>/_probe/<ulid>`, encrypted with the registry key, under the
 * caller's tenant session (`tenantProcessRole` in the processor and the
 * sweep, `tenantPlatformRole` in the platform functions).
 *
 * Its answer is one of three:
 * - `usable`: every call succeeded; a 403 the caller met was its own fault.
 * - `kms`: a call failed with an error sourced in KMS (`KEY_UNAVAILABLE`).
 * - `other`: a call failed for another reason; the caller throws and never
 *   marks the tenant `REVOKED`.
 *
 * The processor skips `_probe` keys at step 0, so a probe never becomes a
 * delivery.
 */

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';
import { errorCode, isKmsSourced } from './errors';
import { probeKey } from './tenant-id';

export type ProbeResult =
  | { readonly outcome: 'usable' }
  | { readonly outcome: 'kms'; readonly errorType: string }
  | { readonly outcome: 'other'; readonly errorType: string };

const PROBE_BODY = 'tenant-encrypted-ingestion probe';

export async function probeKeyThroughS3(s3: S3Client, bucket: string, tenantId: string, keyArn: string): Promise<ProbeResult> {
  const key = probeKey(tenantId, ulid());
  let versionId: string | undefined;
  try {
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: PROBE_BODY,
        ContentType: 'text/plain',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: keyArn,
        BucketKeyEnabled: false,
        IfNoneMatch: '*',
      }),
    );
    versionId = put.VersionId;
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await got.Body?.transformToString();
    return { outcome: 'usable' };
  } catch (error) {
    return isKmsSourced(error) ? { outcome: 'kms', errorType: errorCode(error) } : { outcome: 'other', errorType: errorCode(error) };
  } finally {
    if (versionId !== undefined) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })).catch(() => undefined);
    }
  }
}
