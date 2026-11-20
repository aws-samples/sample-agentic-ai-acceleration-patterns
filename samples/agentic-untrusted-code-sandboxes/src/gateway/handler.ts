// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The gateway entry's tool body (spec §3.2, §5.1, ADR-0001, ADR-0055). It
 * runs inside the producer's `toolHandler`, which has already verified the
 * signed tenant context and stripped `_ri_ctx` from the arguments. The core's
 * `runCode` vends the tool tenant role itself, once the call is validated, so
 * the gateway entry holds no credential. What is left here:
 *
 * - the tenant is `context.tenantId` and nothing else: an argument named
 *   `tenantId` is refused, and so is any other argument the tool does not
 *   declare, so no field can carry a second tenant to the code below;
 * - the verified tenant id must match the §5.1 rule, because it becomes the
 *   session tag, the key prefix, the registry key and the session hash;
 * - the rest of the call is the core's `runCode`, the same function the
 *   standalone entry runs.
 */

import type { ToolInvocation } from 'agentic-runtime-isolation/tools';
import { TENANT_ID_PATTERN } from '../protocol';
import { GATEWAY_ARGUMENTS } from './tool-schema';
import type { RunCodeRequest, RunCodeResult } from '../tool/types';

/**
 * A tool error as the agent sees it (a code and a short fixed message, no
 * value from the call) and one WARN line for the operator. The line is raw
 * JSON on stdout, like the producer's logger, so its fields are queryable
 * under the Lambda JSON log format. `tenantId` is logged only when it
 * fits the tenant id rule.
 */
function refuse(error: string, message: string, invocation: ToolInvocation, reason: string): Record<string, unknown> {
  const { context } = invocation;
  const line = {
    level: 'WARN',
    message: 'tool refused',
    reason,
    tool: context.tool,
    txn: context.txn,
    ...(TENANT_ID_PATTERN.test(context.tenantId) ? { tenantId: context.tenantId } : {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return error === 'invalid_argument' ? { error, message } : { error };
}

/** The type each declared argument must have; the core applies the field rules of spec §5.1 to the values. */
const ARGUMENT_TYPES: Readonly<Record<(typeof GATEWAY_ARGUMENTS)[number], 'string' | 'boolean'>> = {
  code: 'string',
  input: 'string',
  backend: 'string',
  saveOutput: 'boolean',
};

/**
 * The implementation `toolHandler` wraps. `run` is the core's `runCode`,
 * injected so tests run it with a fake; it validates the field rules of
 * spec §5.1 and vends the tenant's credentials itself.
 */
export function gatewayRunCode(run: (request: RunCodeRequest) => Promise<RunCodeResult>): (invocation: ToolInvocation) => Promise<unknown> {
  return async (invocation) => {
    const { context, args } = invocation;
    if (Object.prototype.hasOwnProperty.call(args, 'tenantId')) {
      return refuse('invalid_argument', 'tenantId is not an argument; the tenant comes from the signed context', invocation, 'tenant_argument');
    }
    const allowed: readonly string[] = GATEWAY_ARGUMENTS;
    if (Object.keys(args).some((key) => !allowed.includes(key))) {
      return refuse('invalid_argument', `the arguments are ${GATEWAY_ARGUMENTS.join(', ')}`, invocation, 'unknown_argument');
    }
    // A nested value is the shape a second tenant would travel in, so values are typed here, not only in the core.
    for (const name of GATEWAY_ARGUMENTS) {
      if (name in args && typeof args[name] !== ARGUMENT_TYPES[name]) {
        return refuse('invalid_argument', `${name} must be a ${ARGUMENT_TYPES[name]}`, invocation, 'argument_type');
      }
    }
    if (!TENANT_ID_PATTERN.test(context.tenantId)) {
      // Not the caller's to fix: the verified context carries an id the sample cannot use as a key.
      return refuse('context_invalid', '', invocation, 'tenant_id_rule');
    }
    // The tenant goes last: whatever the arguments hold, the context's id wins.
    // The names and JSON types are checked above; `runCode` checks the values and that `code` is present.
    return run({ ...args, tenantId: context.tenantId } as unknown as RunCodeRequest);
  };
}
