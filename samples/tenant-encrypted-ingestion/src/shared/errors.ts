// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Classifiers for AWS SDK errors. They read the error's name, HTTP status
 * and, for the KMS question only, its message; nothing here logs either.
 *
 * S3 reports a key-policy denial as a plain `AccessDenied` (spec P-5), so
 * no caller classifies a key as gone from an error code: on any 403 the
 * processor and the platform functions run the probe (src/shared/probe.ts),
 * and only a probe failure that names KMS counts as `KEY_UNAVAILABLE`
 * (ADR-0016).
 */

interface SdkErrorLike {
  name?: unknown;
  Code?: unknown;
  code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: number };
  CancellationReasons?: { Code?: string }[];
}

function asSdk(error: unknown): SdkErrorLike {
  return typeof error === 'object' && error !== null ? (error as SdkErrorLike) : {};
}

export function httpStatus(error: unknown): number | undefined {
  return asSdk(error).$metadata?.httpStatusCode;
}

export function errorCode(error: unknown): string {
  const e = asSdk(error);
  for (const candidate of [e.Code, e.code, e.name]) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return 'Unknown';
}

/** A 403 or an `AccessDenied` from S3 (spec §8: triggers the probe). */
export function isAccessDenied(error: unknown): boolean {
  return httpStatus(error) === 403 || errorCode(error) === 'AccessDenied';
}

/** S3 `PreconditionFailed` (412): an `If-Match` or `CopySourceIfMatch` pin missed. */
export function isPreconditionFailed(error: unknown): boolean {
  return httpStatus(error) === 412 || errorCode(error) === 'PreconditionFailed';
}

/** S3 404 (`NotFound`, `NoSuchKey`, `NoSuchVersion`). */
export function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return httpStatus(error) === 404 || code === 'NotFound' || code === 'NoSuchKey' || code === 'NoSuchVersion';
}

/**
 * Whether a failure was sourced in KMS (spec §8 "Probe": a code or message
 * naming `kms:`). Covers `KMS.DisabledException`, `KMS.KMSInvalidStateException`,
 * `KMS.NotFoundException` and an `AccessDenied` whose message names a
 * `kms:` action (a removed key-policy statement).
 */
export function isKmsSourced(error: unknown): boolean {
  const e = asSdk(error);
  const code = errorCode(error);
  const message = typeof e.message === 'string' ? e.message : '';
  return /^kms[.:]/i.test(code) || /kms:/i.test(message) || /\bKMS\./.test(message);
}

/** A DynamoDB conditional check failure. */
export function isConditionalCheckFailed(error: unknown): boolean {
  return errorCode(error) === 'ConditionalCheckFailedException';
}

/** The per-item codes of a cancelled transaction, in request order. */
export function cancellationCodes(error: unknown): string[] | undefined {
  const e = asSdk(error);
  if (errorCode(error) !== 'TransactionCanceledException') {
    return undefined;
  }
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
}
