// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The two presigned requests of the sample (spec §7.5, §3.5; ADR-0006,
 * ADR-0008; M-6, M-20).
 *
 * The write-once PUT is signed by a `tenantUploadRole` session for
 * `ingest/<tenantId>/<deliveryId>` with six headers in `X-Amz-SignedHeaders`.
 * The SDK signs only `host` by default, so the six are listed in
 * `signableHeaders`, and the three `x-amz-*` in `unhoistableHeaders`: a
 * hoisted header becomes a query parameter, which S3 accepts without the
 * header on the request, and the key id or the bucket-key flag would no
 * longer be pinned. The client sends exactly these headers; another key id,
 * a missing SSE header or another length breaks the signature.
 *
 * The validator GET is signed by the `tenantProcessRole` session with
 * `If-Match` signed: this object, these bytes, until it expires.
 *
 * Neither URL is ever logged (N-6, M-27).
 */

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** The six signed headers of the upload, lower-case as SigV4 lists them. */
export const UPLOAD_SIGNED_HEADERS = [
  'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id',
  'x-amz-server-side-encryption-bucket-key-enabled',
  'if-none-match',
  'content-length',
  'content-type',
] as const;

/** The three that must stay headers (never hoisted to the query string). */
export const UPLOAD_UNHOISTABLE_HEADERS = [
  'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id',
  'x-amz-server-side-encryption-bucket-key-enabled',
] as const;

export interface UploadRequest {
  readonly bucket: string;
  readonly key: string;
  readonly keyArn: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresInSeconds: number;
}

export interface PresignedUpload {
  readonly url: string;
  /** The headers the client must send, verbatim. */
  readonly headers: Record<string, string>;
}

export async function presignUpload(s3: S3Client, request: UploadRequest): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: request.bucket,
    Key: request.key,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: request.keyArn,
    BucketKeyEnabled: false,
    IfNoneMatch: '*',
    ContentLength: request.sizeBytes,
    ContentType: request.contentType,
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn: request.expiresInSeconds,
    signableHeaders: new Set<string>(UPLOAD_SIGNED_HEADERS),
    unhoistableHeaders: new Set<string>(UPLOAD_UNHOISTABLE_HEADERS),
  });
  return {
    url,
    headers: {
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': request.keyArn,
      'x-amz-server-side-encryption-bucket-key-enabled': 'false',
      'If-None-Match': '*',
      'Content-Length': String(request.sizeBytes),
      'Content-Type': request.contentType,
    },
  };
}

export interface ObjectReadRequest {
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
  readonly expiresInSeconds: number;
}

/** A GET pinned to one ETag, for a validator (spec §3.5). */
export async function presignPinnedGet(s3: S3Client, request: ObjectReadRequest): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: request.bucket, Key: request.key, IfMatch: request.etag }), {
    expiresIn: request.expiresInSeconds,
    signableHeaders: new Set(['if-match']),
  });
}

/** The `X-Amz-SignedHeaders` list of a presigned URL (for tests and the integ). */
export function signedHeadersOf(url: string): string[] {
  const value = new URL(url).searchParams.get('X-Amz-SignedHeaders');
  return value === null ? [] : value.split(';');
}
