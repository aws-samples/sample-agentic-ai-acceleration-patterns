// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { isDependencyThrottle, THROTTLE_RETRY_AFTER_SECONDS, THROTTLED_MESSAGE } from '../../src/shared/throttling';

describe('isDependencyThrottle (ADR-0037)', () => {
  const named = (name: string): Error => Object.assign(new Error('Rate exceeded; sensitive detail'), { name });

  it.each([
    'TooManyRequestsException', // Cognito
    'LimitExceededException', // Cognito, API Gateway
    'ThrottlingException', // generic JSON protocol
    'Throttling', // STS (query protocol), pool-per-tenant AssumeRole
    'ProvisionedThroughputExceededException', // DynamoDB
    'RequestLimitExceeded', // DynamoDB
  ])('%s is a dependency throttle', (name) => {
    expect(isDependencyThrottle(named(name))).toBe(true);
  });

  it.each(['BadRequestException', 'InternalErrorException', 'ResourceNotFoundException', 'Error'])(
    '%s is not',
    (name) => {
      expect(isDependencyThrottle(named(name))).toBe(false);
    },
  );

  it('a non-Error value is not a throttle', () => {
    expect(isDependencyThrottle('Throttling')).toBe(false);
    expect(isDependencyThrottle(undefined)).toBe(false);
  });

  it('the fixed message carries no dependency text and the wait is one second', () => {
    expect(THROTTLED_MESSAGE).toBe('A dependency throttled the request; retry after a short wait');
    expect(THROTTLE_RETRY_AFTER_SECONDS).toBe(1);
  });
});
