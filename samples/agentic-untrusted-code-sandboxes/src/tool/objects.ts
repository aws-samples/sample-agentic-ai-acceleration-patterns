// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The tenant's input and output objects (spec §4.2, ADR-0006). The tool
 * reads the input with the tenant's own credentials and hands the sandbox the
 * bytes; the sandbox never fetches. The tool tenant role allows
 * `inputs/${TenantId}/*` and `outputs/${TenantId}/*` only, so a key under
 * another prefix is an IAM refusal, not a code check.
 */

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { TenantCredentials } from '../backend';

/** The input name rule (spec §5.1): `[A-Za-z0-9._/-]{1,256}`, no `..`, no leading `/`. */
export const INPUT_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,256}$/;

export function validInputName(name: unknown): name is string {
  return typeof name === 'string' && INPUT_NAME_PATTERN.test(name) && !name.includes('..') && !name.startsWith('/');
}

export class InputError extends Error {
  public constructor(public readonly code: 'input_not_found' | 'input_too_large') {
    super(code);
    this.name = 'InputError';
  }
}

export interface ObjectStore {
  /**
   * The object's bytes. Throws InputError: `input_too_large` when it is above
   * `maxBytes` (decided from the size, before the body is read), and
   * `input_not_found` when there is no such object. S3 answers 403, not 404,
   * for a missing key when the caller may not list the bucket, so both map to
   * `input_not_found` and the caller never learns which it was.
   */
  readInput(tenantId: string, name: string, maxBytes: number): Promise<Uint8Array>;
  /** Writes `outputs/<tenantId>/<runId>.json`. */
  writeOutput(tenantId: string, runId: string, body: string): Promise<void>;
}

export const inputKey = (tenantId: string, name: string) => `inputs/${tenantId}/${name}`;
export const outputKey = (tenantId: string, runId: string) => `outputs/${tenantId}/${runId}.json`;

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

const MISSING = new Set(['NotFound', 'NoSuchKey', 'AccessDenied', 'Forbidden']);

function isMissing(error: unknown): boolean {
  return (error instanceof Error && MISSING.has(error.name)) || status(error) === 404 || status(error) === 403;
}

export function s3ObjectStore(bucket: string, creds: TenantCredentials, client?: S3Client): ObjectStore {
  const s3 = client ?? new S3Client({
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken },
  });
  return {
    async readInput(tenantId, name, maxBytes) {
      const Key = inputKey(tenantId, name);
      let etag: string | undefined;
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
        if ((head.ContentLength ?? 0) > maxBytes) throw new InputError('input_too_large');
        etag = head.ETag;
      } catch (error) {
        if (error instanceof InputError) throw error;
        if (isMissing(error)) throw new InputError('input_not_found');
        throw error;
      }
      let body: Uint8Array;
      try {
        // IfMatch pins the object the size check saw: a bigger one swapped in meanwhile is refused.
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key, IfMatch: etag }));
        body = (await out.Body?.transformToByteArray()) ?? new Uint8Array(0);
      } catch (error) {
        if (isMissing(error)) throw new InputError('input_not_found');
        throw error;
      }
      if (body.length > maxBytes) throw new InputError('input_too_large');
      return body;
    },
    async writeOutput(tenantId, runId, body) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey(tenantId, runId),
        Body: body,
        ContentType: 'application/json',
      }));
    },
  };
}
