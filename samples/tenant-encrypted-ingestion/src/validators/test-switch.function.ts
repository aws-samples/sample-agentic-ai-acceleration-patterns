// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `test-switch` validator (spec §10): its behaviour is the value of an
 * SSM parameter the integration test writes, so nothing redeploys between
 * steps. It never reads the document.
 *
 * - `accept` (and any unknown value): ACCEPT.
 * - `throw`: a function error (a validator error; step 7b).
 * - `pause` or `pause:<seconds>`: waits `PAUSE_SECONDS` (or the given
 *   seconds, capped a second short of the function's remaining time), then
 *   ACCEPT, so the test can disable a key or change its policy while the
 *   delivery is `PROCESSING` (step 8). The processor waits on the invoke, so
 *   the pause must stay under the processor timeout T less its other work.
 * - `sleep`: sleeps until its own function timeout, past the timeout it
 *   declares to the chain, so the processor times out holding the lease
 *   (step 7c).
 *
 * The mode is read on every call (no cache), and only the mode is logged.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Context } from 'aws-lambda';
import { requireEnv } from '../shared/constants';
import { log } from '../shared/logger';

export const TEST_SWITCH_PARAMETER_ENV = 'TEI_TEST_SWITCH_PARAMETER';
export const TEST_SWITCH_MODES = ['accept', 'throw', 'pause', 'sleep'] as const;
export const PAUSE_SECONDS = 45;

/** The pause in milliseconds for a `pause` or `pause:<seconds>` mode, or undefined for any other mode. */
export function pauseMillis(mode: string, remainingMillis: number): number | undefined {
  const match = /^pause(?::(\d{1,4}))?$/.exec(mode);
  if (match === null) {
    return undefined;
  }
  const requested = (match[1] === undefined ? PAUSE_SECONDS : Number(match[1])) * 1000;
  return Math.max(0, Math.min(requested, remainingMillis - 1000));
}

const ssm = new SSMClient({});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handler(_request: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>): Promise<{ version: '1'; verdict: 'ACCEPT' }> {
  const parameter = await ssm.send(new GetParameterCommand({ Name: requireEnv(TEST_SWITCH_PARAMETER_ENV) }));
  const mode = parameter.Parameter?.Value ?? 'accept';
  log.info('test-switch called', { validator: 'test-switch', outcome: mode });
  const pause = pauseMillis(mode, context.getRemainingTimeInMillis());
  if (pause !== undefined) {
    await wait(pause);
    return { version: '1', verdict: 'ACCEPT' };
  }
  switch (mode) {
    case 'throw':
      throw new Error('test-switch: mode throw');
    case 'sleep':
      await wait(context.getRemainingTimeInMillis() + 1000);
      break;
    default:
      break;
  }
  return { version: '1', verdict: 'ACCEPT' };
}
