// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Running the custom validator chain (spec §3.5, §8 step 5, P-11; M-20,
 * M-21; ADR-0008).
 *
 * For each validator, in order: a GET presigned by the `tenantProcessRole`
 * session with `If-Match` signed (src/shared/presign.ts), then one
 * synchronous invoke under `processorRole`. The chain stops at the first REJECT. A function error,
 * a timeout or a schema-invalid verdict is a VALIDATOR ERROR: the caller
 * throws it (retry) or, on the last receive, rejects the delivery with
 * `<name>:VALIDATOR_ERROR`.
 *
 * Logging: one line per call with `tenantId`, `deliveryId`, `validator`,
 * `verdict`, `code`, `durationMs`; a validator error logs only its type.
 * Never the URL, the request, the response body or an error's message.
 */

import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { S3Client } from '@aws-sdk/client-s3';
import { parseVerdict } from './verdict';
import { errorName, log } from '../shared/logger';
import { presignPinnedGet } from '../shared/presign';
import type { ValidatorRecord } from '../shared/registry';

/** One validator as the construct passes it to the processor (`TEI_VALIDATORS`). */
export interface ValidatorBinding {
  readonly name: string;
  readonly functionArn: string;
  readonly timeoutSeconds: number;
}

export interface DeliveryFacts {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
}

export type ChainOutcome =
  | { readonly outcome: 'accepted'; readonly records: ValidatorRecord[] }
  | { readonly outcome: 'rejected'; readonly validator: string; readonly code: string; readonly message?: string; readonly records: ValidatorRecord[] }
  | { readonly outcome: 'error'; readonly validator: string; readonly errorType: string; readonly records: ValidatorRecord[] };

export interface ChainDependencies {
  readonly lambda: LambdaClient;
  /** The tenant session's S3 client: it signs the validator URLs. */
  readonly s3: S3Client;
  readonly urlTtlSeconds: number;
  readonly now?: () => number;
  /** Called once per validator GET signed, for KMS metering. */
  readonly onRead?: () => void;
}

/** Parses `TEI_VALIDATORS` (JSON array written by the construct). */
export function parseValidatorBindings(json: string | undefined): ValidatorBinding[] {
  if (json === undefined || json.length === 0) {
    return [];
  }
  const parsed = JSON.parse(json) as ValidatorBinding[];
  return parsed.map((v) => ({ name: v.name, functionArn: v.functionArn, timeoutSeconds: v.timeoutSeconds }));
}

export async function runValidatorChain(
  validators: readonly ValidatorBinding[],
  facts: DeliveryFacts,
  deps: ChainDependencies,
): Promise<ChainOutcome> {
  const now = deps.now ?? Date.now;
  const records: ValidatorRecord[] = [];
  const previous: { validator: string; verdict: string }[] = [{ validator: 'structural', verdict: 'ACCEPT' }];
  for (const validator of validators) {
    const start = now();
    const objectUrl = await presignPinnedGet(deps.s3, {
      bucket: facts.bucket,
      key: facts.key,
      etag: facts.etag,
      expiresInSeconds: deps.urlTtlSeconds,
    });
    deps.onRead?.();
    const request = {
      version: '1',
      tenantId: facts.tenantId,
      deliveryId: facts.deliveryId,
      fileName: facts.fileName,
      contentType: facts.contentType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      objectUrl,
      etag: facts.etag,
      objectUrlExpiresAt: new Date(start + deps.urlTtlSeconds * 1000).toISOString(),
      previous: [...previous],
    };
    let verdict;
    try {
      verdict = await invokeValidator(deps.lambda, validator, request);
    } catch (error) {
      const durationMs = now() - start;
      const errorType = errorName(error);
      records.push({ validator: validator.name, verdict: 'ERROR', code: 'VALIDATOR_ERROR', durationMs });
      log.warn('validator error', {
        tenantId: facts.tenantId,
        deliveryId: facts.deliveryId,
        validator: validator.name,
        verdict: 'ERROR',
        errorType,
        durationMs,
      });
      return { outcome: 'error', validator: validator.name, errorType, records };
    }
    const durationMs = now() - start;
    const code = verdict.verdict === 'REJECT' ? verdict.code : undefined;
    records.push({ validator: validator.name, verdict: verdict.verdict, ...(code !== undefined ? { code } : {}), durationMs });
    log.info('validator verdict', {
      tenantId: facts.tenantId,
      deliveryId: facts.deliveryId,
      validator: validator.name,
      verdict: verdict.verdict,
      code,
      durationMs,
    });
    if (verdict.verdict === 'REJECT') {
      return { outcome: 'rejected', validator: validator.name, code: verdict.code, message: verdict.message, records };
    }
    previous.push({ validator: validator.name, verdict: 'ACCEPT' });
  }
  return { outcome: 'accepted', records };
}

export class ValidatorFunctionError extends Error {
  constructor() {
    super('validator function error');
    this.name = 'ValidatorFunctionError';
  }
}

export class InvalidVerdictError extends Error {
  constructor() {
    super('validator verdict is schema-invalid');
    this.name = 'InvalidVerdictError';
  }
}

/**
 * One synchronous invoke. The processor does not abort the call at the
 * validator's declared timeout: the declared timeout is what T is computed
 * from (spec §8 "Timing"), and a validator that runs past it runs into its
 * own function timeout (a `FunctionError`, a validator error) or, if its
 * function allows longer than it declared, into the processor's own
 * timeout, which leaves the lease for the next receive or the sweep
 * (spec §10 step 7c relies on exactly that).
 */
async function invokeValidator(lambda: LambdaClient, validator: ValidatorBinding, request: object) {
  const response = await lambda.send(
    new InvokeCommand({ FunctionName: validator.functionArn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(request)) }),
  );
  if (response.FunctionError !== undefined) {
    // The error body is the validator's and is never logged or stored.
    throw new ValidatorFunctionError();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(response.Payload ?? new Uint8Array()).toString('utf8'));
  } catch {
    throw new InvalidVerdictError();
  }
  const verdict = parseVerdict(body);
  if (verdict === undefined) {
    throw new InvalidVerdictError();
  }
  return verdict;
}
