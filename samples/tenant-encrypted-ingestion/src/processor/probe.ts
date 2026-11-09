// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The processor's fail-closed classifier (spec P-5, §8 "Probe", M-18,
 * ADR-0004). Every S3 call at steps 3 to 8 goes through `guardS3`. On a
 * 403 / `AccessDenied` the processor never decides from the error code (a
 * key-policy denial is a plain `AccessDenied`): it runs the probe through
 * S3 under the same session (src/shared/probe.ts).
 *
 * - The probe fails with a KMS-sourced error: `KeyUnavailableError`; the
 *   handler records `KEY_UNAVAILABLE`, marks the key `REVOKED`, deletes the
 *   drop version, publishes `DeliveryKeyUnavailable` and deletes the message
 *   (no DLQ retry).
 * - The probe succeeds, or fails for another reason: the fault is the
 *   pipeline's own; the ORIGINAL error is rethrown (SQS retries), and the
 *   tenant is never marked `REVOKED`.
 *
 * An error that itself names KMS (`KMS.DisabledException`, which S3 does not
 * always return as a 403) also triggers the probe, so a disabled key is
 * decided the same way; it is still the probe that decides.
 */

import { isAccessDenied, isKmsSourced } from '../shared/errors';
import type { ProbeResult } from '../shared/probe';

export class KeyUnavailableError extends Error {
  constructor(readonly kmsError: string) {
    super('the tenant key cannot be used');
    this.name = 'KeyUnavailableError';
  }
}

export async function guardS3<T>(call: () => Promise<T>, probe: () => Promise<ProbeResult>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isAccessDenied(error) && !isKmsSourced(error)) {
      throw error;
    }
    const result = await probe();
    if (result.outcome === 'kms') {
      throw new KeyUnavailableError(result.errorType);
    }
    throw error;
  }
}
