// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The built-in structural checks (spec §8 steps 3 and 4, P-10, M-9). They
 * come first in the chain; custom validators run only on a drop that passed
 * them.
 *
 * Step 3, on `HeadObject` (no content read):
 * - `KEY_MISMATCH`: not SSE-KMS, `SSEKMSKeyId` other than the registry
 *   `keyArn`, or `BucketKeyEnabled` (a bucket key breaks the prefix binding,
 *   spec §7.2; the request already fails closed, this makes it visible).
 * - `STORAGE_CLASS`: other than `STANDARD` (S3 omits the field for STANDARD).
 * - `TOO_LARGE` over `maxObjectSizeBytes`, else `SIZE_MISMATCH` when the
 *   length is not the declared size.
 *
 * Step 4, on one streamed `GetObject` pinned to the drop ETag:
 * - `UNSUPPORTED_TYPE` when the declared type is outside the allowlist,
 *   `TYPE_MISMATCH` when the magic bytes are not the declared type's;
 * - `BAD_ARCHIVE` for a ZIP whose central directory is missing,
 *   inconsistent, ZIP64, larger than the tail kept in memory, over
 *   `MAX_ZIP_ENTRIES`, expands past `MAX_ZIP_EXPANSION` times its size or
 *   `MAX_ZIP_UNCOMPRESSED_BYTES`, or names a path that escapes its root;
 * - the `sha256` of the bytes, which lands on the row.
 *
 * The stream is read once: the first bytes are kept for the magic check,
 * the last `TAIL_BYTES` for the ZIP end-of-central-directory, and every
 * byte goes through the hash. Nothing is buffered beyond those two windows.
 */

import { createHash } from 'node:crypto';
import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3';

export type StructuralCode =
  | 'TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'UNSUPPORTED_TYPE'
  | 'BAD_ARCHIVE'
  | 'KEY_MISMATCH'
  | 'STORAGE_CLASS'
  | 'OBJECT_CHANGED'
  | 'PROCESSING_ABANDONED';

/** `structural:<CODE>`, the reason a row records. */
export function structuralReason(code: StructuralCode): string {
  return `structural:${code}`;
}

export const DEFAULT_ALLOWED_CONTENT_TYPES = ['application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'image/tiff'] as const;

const MAGIC: ReadonlyArray<{ type: string; signatures: number[][] }> = [
  { type: 'application/pdf', signatures: [[0x25, 0x50, 0x44, 0x46, 0x2d]] }, // %PDF-
  { type: 'application/zip', signatures: [[0x50, 0x4b, 0x03, 0x04]] }, // PK\3\4 (an empty archive is refused)
  { type: 'image/png', signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { type: 'image/jpeg', signatures: [[0xff, 0xd8, 0xff]] },
  { type: 'image/tiff', signatures: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
];

/** The media type the first bytes identify, or undefined. */
export function detectType(head: Uint8Array): string | undefined {
  for (const { type, signatures } of MAGIC) {
    if (signatures.some((sig) => sig.length <= head.length && sig.every((b, i) => head[i] === b))) {
      return type;
    }
  }
  return undefined;
}

/** Step 3. */
export function headProblem(
  head: Pick<HeadObjectCommandOutput, 'ServerSideEncryption' | 'SSEKMSKeyId' | 'BucketKeyEnabled' | 'StorageClass' | 'ContentLength'>,
  expected: { keyArn: string; declaredSizeBytes: number; maxObjectSizeBytes: number },
): StructuralCode | undefined {
  if (head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== expected.keyArn || head.BucketKeyEnabled === true) {
    return 'KEY_MISMATCH';
  }
  if (head.StorageClass !== undefined && head.StorageClass !== 'STANDARD') {
    return 'STORAGE_CLASS';
  }
  const length = head.ContentLength ?? -1;
  if (length > expected.maxObjectSizeBytes) {
    return 'TOO_LARGE';
  }
  if (length !== expected.declaredSizeBytes) {
    return 'SIZE_MISMATCH';
  }
  return undefined;
}

export const HEAD_BYTES = 16;
/** The largest ZIP central directory kept, plus the EOCD and its comment. */
export const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;
export const TAIL_BYTES = MAX_ZIP_CENTRAL_DIRECTORY_BYTES + 22 + 65535;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_EXPANSION = 100;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;

export interface StreamDigest {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly head: Buffer;
  readonly tail: Buffer;
}

/** Reads the stream once: hash, size, first `HEAD_BYTES`, last `TAIL_BYTES`. */
export async function digestStream(body: AsyncIterable<Uint8Array>): Promise<StreamDigest> {
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    hash.update(buf);
    size += buf.length;
    if (head.length < HEAD_BYTES) {
      head = Buffer.concat([head, buf.subarray(0, HEAD_BYTES - head.length)]);
    }
    tail = Buffer.concat([tail, buf]);
    if (tail.length > TAIL_BYTES) {
      tail = tail.subarray(tail.length - TAIL_BYTES);
    }
  }
  return { sha256: hash.digest('hex'), sizeBytes: size, head, tail: Buffer.from(tail) };
}

/** A problem with a ZIP's central directory, or undefined (M-9). */
export function zipProblem(tail: Buffer, totalSize: number): string | undefined {
  // End of central directory: signature 0x06054b50, at least 22 bytes from the end.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0 && i >= tail.length - 22 - 65535; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return 'no end of central directory';
  }
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return 'ZIP64 is not accepted';
  }
  if (entries === 0) {
    return 'empty archive';
  }
  if (entries > MAX_ZIP_ENTRIES) {
    return 'too many entries';
  }
  const tailStart = totalSize - tail.length;
  const eocdAbsolute = tailStart + eocd;
  if (cdOffset + cdSize !== eocdAbsolute) {
    return 'central directory is not where the end record says';
  }
  if (cdSize > MAX_ZIP_CENTRAL_DIRECTORY_BYTES || cdOffset < tailStart) {
    return 'central directory too large';
  }
  let p = cdOffset - tailStart;
  let uncompressed = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || tail.readUInt32LE(p) !== 0x02014b50) {
      return 'central directory entry is malformed';
    }
    const size = tail.readUInt32LE(p + 24);
    const nameLength = tail.readUInt16LE(p + 28);
    const extraLength = tail.readUInt16LE(p + 30);
    const commentLength = tail.readUInt16LE(p + 32);
    if (size === 0xffffffff) {
      return 'ZIP64 is not accepted';
    }
    const name = tail.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) {
      return 'entry path escapes the archive root';
    }
    uncompressed += size;
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== eocd) {
    return 'central directory size does not match its entries';
  }
  if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES || uncompressed > MAX_ZIP_EXPANSION * Math.max(totalSize, 1)) {
    return 'archive expands too far';
  }
  return undefined;
}

/** Step 4 on a digest. */
export function contentProblem(
  digest: StreamDigest,
  declaredContentType: string,
  allowedContentTypes: readonly string[],
): StructuralCode | undefined {
  if (!allowedContentTypes.includes(declaredContentType)) {
    return 'UNSUPPORTED_TYPE';
  }
  if (detectType(digest.head) !== declaredContentType) {
    return 'TYPE_MISMATCH';
  }
  if (declaredContentType === 'application/zip' && zipProblem(digest.tail, digest.sizeBytes) !== undefined) {
    return 'BAD_ARCHIVE';
  }
  return undefined;
}
