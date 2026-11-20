// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The `run_code` tool as the tools gateway lists it (spec §5.1, ADR-0001,
 * ADR-0055): its name, its argument schema and the rules for the arguments
 * the gateway entry checks itself. Everything else about the arguments
 * (code size, input name, backend, saveOutput) is the core's rule, applied
 * to the same fields on both entries.
 *
 * A Lambda target's input schema carries only `type`, `properties`,
 * `required`, `items` and `description`, so the limits an agent writes code
 * for are in the descriptions, not in `pattern` or `enum`.
 */

import type { ToolDefinition } from 'agentic-runtime-isolation';
import type { BackendName } from '../backend';

/** The tool name inside its target; the gateway lists it as `<target>___run_code` (agentic-runtime-isolation spec §3.5). */
export const RUN_CODE_TOOL = 'run_code';

/** The default target name, `toolName` on `RunCodeToolTarget`. */
export const DEFAULT_TARGET_NAME = 'run-code';

/** The only arguments the gateway entry accepts. `tenantId` is not one of them (spec §3.2). */
export const GATEWAY_ARGUMENTS = ['code', 'input', 'backend', 'saveOutput'] as const;

const DESCRIPTION = [
  'Runs a Python script in a sandbox that belongs to the calling tenant and returns its exit code, stdout, stderr and timing.',
  'The sandbox has no internet access; do not call the internet or an AWS API from the script.',
  'Files in /work persist between calls to the same tenant sandbox until it is stopped for being idle.',
  'To read a file, name its object under the tenant inputs/ prefix in "input"; the script reads its bytes from the file /work/input and cannot fetch anything itself.',
  'Limits depend on the backend. On microvm a process has 256 MiB of address space, threads and processes are capped,',
  'multiprocessing locks and pools fail with PermissionError, and sockets, shared memory and io_uring are filtered.',
  'On nitro and agentcore a process can use most of the sandbox memory.',
  'A script that times out, is killed or exits non-zero is not an error: the result says so.',
  'A call can return sandbox_starting or sandbox_failed with retryAfterSeconds; call again after that many seconds.',
].join(' ');

/** The `run_code` tool definition for the target, naming the backends this deployment offers. */
export function runCodeToolDefinition(backends: readonly BackendName[], defaultBackend: BackendName): ToolDefinition {
  return {
    name: RUN_CODE_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'UTF-8 Python source, at most 64 KiB.',
        },
        input: {
          type: 'string',
          description: 'Optional object name under the tenant inputs/ prefix, read by the script from /work/input: letters, digits, dot, slash, underscore and hyphen, 1 to 256 characters, no "..", no leading slash.',
        },
        backend: {
          type: 'string',
          description: `Optional boundary to run on: one of ${backends.join(', ')}. Default ${defaultBackend}.`,
        },
        saveOutput: {
          type: 'boolean',
          description: 'Also write the result under the tenant outputs/ prefix.',
        },
      },
      required: ['code'],
    },
  };
}
