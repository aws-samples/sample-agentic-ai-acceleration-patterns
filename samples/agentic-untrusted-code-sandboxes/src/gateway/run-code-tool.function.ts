// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Lambda entry of the gateway `run_code` target (spec §3.3, ADR-0017,
 * ADR-0055). `toolHandler` of agentic-runtime-isolation verifies the signed
 * tenant context and logs one line per call; `gatewayRunCode` then runs the
 * core's `runCode` for that tenant only. `runCode` gets the function's
 * remaining time, so a call that has used most of it does not start a second
 * sandbox.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { toolHandler } from 'agentic-runtime-isolation/tools';
import type { Context } from 'aws-lambda';
import { gatewayRunCode } from './handler';
import { runCode } from '../tool/run-code';

/** `toolHandler` passes the body no Lambda context, so the current call's travels beside it. */
const current = new AsyncLocalStorage<Context>();

const tool = toolHandler(
  gatewayRunCode((request) => {
    const context = current.getStore();
    return runCode(request, undefined, { remainingMs: context === undefined ? undefined : () => context.getRemainingTimeInMillis() });
  }),
);

export const handler = (event: Record<string, unknown>, context?: Context): Promise<unknown> =>
  context === undefined ? tool(event) : current.run(context, () => tool(event, context));
