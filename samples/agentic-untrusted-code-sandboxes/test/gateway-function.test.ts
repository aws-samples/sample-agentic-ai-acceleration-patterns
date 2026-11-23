// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The Lambda entry of the gateway target (ADR-0055): the function's remaining
// time reaches `runCode` for the call it belongs to, and for no other.
// `toolHandler` and `runCode` are replaced; test/gateway.test.ts runs the
// real `toolHandler`.

import type { Context } from 'aws-lambda';

const runCode = jest.fn(async (..._args: unknown[]) => ({ runId: 'r1' }));

jest.mock('../src/tool/run-code', () => ({ runCode: (...args: unknown[]) => runCode(...args) }));
const seenLambdaContext = jest.fn();

jest.mock('agentic-runtime-isolation/tools', () => ({
  toolHandler:
    (implementation: (invocation: unknown) => Promise<unknown>) =>
      async (event: Record<string, unknown>, lambdaContext?: unknown) => {
        // The real toolHandler reads the tool name from this context; without it every call is context_invalid.
        seenLambdaContext(lambdaContext);
        return implementation({ context: { tenantId: 'tenant-a', tool: 'run-code/run_code', txn: 't' }, args: event });
      },
}));

// eslint-disable-next-line import/first
import { handler } from '../src/gateway/run-code-tool.function';

const lambdaContext = (remaining: number): Context => ({ getRemainingTimeInMillis: () => remaining }) as unknown as Context;

beforeEach(() => {
  seenLambdaContext.mockReset();
  runCode.mockReset();
  runCode.mockResolvedValue({ runId: 'r1' });
});

test('runCode gets the tenant and the remaining time of this call', async () => {
  await handler({ code: 'x' }, lambdaContext(41_000));
  const [request, deps, options] = runCode.mock.calls[0] as [unknown, unknown, { remainingMs?: () => number }];
  expect(request).toEqual({ code: 'x', tenantId: 'tenant-a' });
  expect(deps).toBeUndefined();
  expect(options.remainingMs?.()).toBe(41_000);
});

test('two calls in flight each see their own remaining time', async () => {
  const seen: number[] = [];
  runCode.mockImplementation(async (...args: unknown[]) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(((args[2] as { remainingMs: () => number }).remainingMs)());
    return { runId: 'r' };
  });
  await Promise.all([handler({ code: 'a' }, lambdaContext(1_000)), handler({ code: 'b' }, lambdaContext(2_000))]);
  expect(seen.sort()).toEqual([1_000, 2_000]);
});

test('a call with no Lambda context passes no remaining-time function', async () => {
  await handler({ code: 'x' });
  expect((runCode.mock.calls[0] as unknown as [unknown, unknown, { remainingMs?: unknown }])[2].remainingMs).toBeUndefined();
});

test('the Lambda context reaches toolHandler, which names the tool from it', async () => {
  const context = lambdaContext(5_000);
  await handler({ code: 'x' }, context);
  expect(seenLambdaContext).toHaveBeenCalledWith(context);
  await handler({ code: 'x' });
  expect(seenLambdaContext).toHaveBeenLastCalledWith(undefined);
});
