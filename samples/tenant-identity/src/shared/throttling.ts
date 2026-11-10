// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { errorName } from './logger';

/**
 * Error names the AWS SDK raises when a dependency refuses a call for rate,
 * not for content: Cognito (`TooManyRequestsException`,
 * `LimitExceededException`), DynamoDB (`ProvisionedThroughputExceededException`,
 * `RequestLimitExceeded`), STS (`Throttling`) and the generic
 * `ThrottlingException`. The refused call changed nothing and passes on
 * retry; what earlier steps of the same operation changed is the
 * operation's business (ADR-0037).
 */
export const DEPENDENCY_THROTTLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'ThrottlingException',
  // STS (query protocol) spells it without the suffix: the pool-per-tenant
  // tenant API meets it on AssumeRole (ADR-0026).
  'Throttling',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);

/** Seconds the API tells a throttled caller to wait (`Retry-After`). */
export const THROTTLE_RETRY_AFTER_SECONDS = 1;

/** The fixed message of a `ThrottlingError`: no dependency text, no input (N-6). */
export const THROTTLED_MESSAGE = 'A dependency throttled the request; retry after a short wait';

/** True when `error` is a dependency throttle by its SDK error name. */
export function isDependencyThrottle(error: unknown): boolean {
  return DEPENDENCY_THROTTLE_ERROR_NAMES.has(errorName(error));
}
