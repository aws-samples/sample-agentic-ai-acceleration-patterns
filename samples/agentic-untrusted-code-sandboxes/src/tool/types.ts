// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The input and output of `runCode` (spec §5.1, ADR-0032). Types only, so the
 * gateway entry and the vendor's own tool can import them without pulling in
 * any AWS client.
 */

import type { BackendName } from '../backend';

/** Tool error codes (spec §5.1). `context_invalid` is the gateway entry's, from `toolHandler`. */
export type ToolErrorCode =
  | 'invalid_argument'
  | 'input_not_found'
  | 'input_too_large'
  | 'backend_disabled'
  | 'sandbox_starting'
  | 'sandbox_busy'
  | 'sandbox_failed'
  | 'tool_failed';

/** What a caller passes. On the gateway entry `tenantId` comes from the verified context, never from the agent. */
export interface RunCodeRequest {
  /** `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, from a verified identity only (spec P-2). */
  readonly tenantId: string;
  /** UTF-8 Python, at most 64 KiB. */
  readonly code: string;
  /** Object name under the tenant's `inputs/` prefix. */
  readonly input?: string;
  /** One of the enabled backends; the default backend when absent. */
  readonly backend?: string;
  /** Also write the result to `outputs/<tenantId>/<runId>.json`. */
  readonly saveOutput?: boolean;
}

/** A successful call, including a script that exits non-zero, times out or is killed (spec §5.1). */
export interface RunCodeOutput {
  readonly runId: string;
  readonly backend: BackendName;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly memoryExceeded: boolean;
  readonly durationMs: number;
  /** `started` when this call began, or found a restarted, sandbox; `reused` otherwise. */
  readonly sandbox: 'started' | 'reused';
}

/** A tool error. It is returned, never thrown, so the code reaches the caller (spec §3.3: a Lambda error carries no code). */
export interface RunCodeError {
  readonly error: ToolErrorCode;
  /** Set on `sandbox_starting` and `sandbox_failed`. */
  readonly retryAfterSeconds?: number;
}

/** `runCode` never throws: it returns one of these. */
export type RunCodeResult = RunCodeOutput | RunCodeError;

export function isRunCodeError(result: RunCodeResult): result is RunCodeError {
  return typeof (result as RunCodeError).error === 'string';
}
