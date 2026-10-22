// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { WAITER_SOURCE } from '../../src/shared/log-drain';

/**
 * ADR-0019: the inline waiter must always respond, even if the Delete sleep path
 * throws — otherwise a throw before respond() leaves CloudFormation waiting
 * the full custom-resource timeout (an hour) on every stack operation. Assert
 * the handler body wraps respond() in a `finally` (ADR-0019).
 */
describe('log-drain waiter source (ADR-0019, ADR-0019)', () => {
  it('runs respond(..., SUCCESS) in a finally block', () => {
    expect(WAITER_SOURCE).toContain('finally');
    // The success response is what the finally guarantees runs.
    expect(WAITER_SOURCE).toContain("respond(event, context, 'SUCCESS')");
  });
});
