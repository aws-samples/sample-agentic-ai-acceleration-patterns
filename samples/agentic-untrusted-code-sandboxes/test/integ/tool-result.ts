// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Reads what a `run_code` call returned, on the gateway entry (an MCP
 * `tools/call` answer) and on the standalone entry (a Lambda response), into
 * one shape the steps check. Pure; unit-tested with both shapes.
 *
 * The result fields are spec §5.1. A tool error carries a `code` of the §5.1
 * table; the shape that carries it differs by entry, so the reader accepts a
 * JSON object with `error` (the tool's own field), `code`, `errorCode` or `error.code`, a Lambda error
 * payload whose message holds the code, or plain text that names one.
 */

export const ERROR_CODES = [
  'context_invalid', 'invalid_argument', 'input_not_found', 'input_too_large', 'backend_disabled',
  'sandbox_starting', 'sandbox_busy', 'sandbox_failed', 'tool_failed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RunResult {
  readonly runId: string;
  readonly backend: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly memoryExceeded: boolean;
  readonly durationMs: number;
  readonly sandbox: 'started' | 'reused';
}

export type Outcome =
  | { readonly kind: 'result'; readonly result: RunResult }
  | { readonly kind: 'error'; readonly code: ErrorCode | 'unknown'; readonly retryAfterSeconds?: number }
  /** The caller was refused before the tool ran (HTTP 401, 403, or a Lambda invoke refusal). */
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unreadable' };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isResult(v: unknown): v is RunResult {
  return isObject(v) && typeof v.exitCode === 'number' && typeof v.stdout === 'string' && typeof v.timedOut === 'boolean';
}

function codeIn(text: string): ErrorCode | undefined {
  return ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text));
}

function errorFrom(v: unknown, rawText: string): Outcome {
  let code: string | undefined;
  let retry: number | undefined;
  if (isObject(v)) {
    const nested = isObject(v.error) ? v.error : undefined;
    for (const c of [v.error, v.code, v.errorCode, nested?.code]) if (typeof c === 'string') code = code ?? c;
    for (const r of [v.retryAfterSeconds, nested?.retryAfterSeconds]) if (typeof r === 'number') retry = retry ?? r;
  }
  const known = ERROR_CODES.find((c) => c === code) ?? codeIn(rawText);
  return { kind: 'error', code: known ?? 'unknown', ...(retry !== undefined ? { retryAfterSeconds: retry } : {}) };
}

/** An MCP `tools/call` answer (JSON-RPC over HTTP; the body may be a one-event event stream). */
export function parseGatewayResponse(status: number, body: string): Outcome {
  if (status === 401 || status === 403) return { kind: 'refused', status };
  let text = body.trim();
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const data = text.split('\n').find((l) => l.startsWith('data:'));
    text = data ? data.slice(5).trim() : '';
  }
  const rpc = parseJson(text);
  if (!isObject(rpc)) return { kind: 'unreadable' };
  if (isObject(rpc.error)) return errorFrom(rpc.error, JSON.stringify(rpc.error));
  const result = rpc.result;
  if (!isObject(result)) return { kind: 'unreadable' };
  const structured = result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content.find((c) => isObject(c) && typeof c.text === 'string') as { text: string } | undefined;
  const inner = isObject(structured) ? structured : parseJson(first?.text ?? '');
  if (isResult(inner)) return { kind: 'result', result: inner };
  if (result.isError === true || isObject(inner)) return errorFrom(inner, first?.text ?? '');
  return first ? errorFrom(undefined, first.text) : { kind: 'unreadable' };
}

/** A direct Lambda invoke of `runCodeFunction`: `functionError` is the response's `FunctionError`, `payload` its body. */
export function parseFunctionResponse(functionError: string | undefined, payload: string): Outcome {
  const v = parseJson(payload);
  if (functionError === undefined && isResult(v)) return { kind: 'result', result: v };
  if (isObject(v) && typeof v.errorMessage === 'string') {
    const inner = parseJson(v.errorMessage);
    return errorFrom(isObject(inner) ? inner : v, `${v.errorType ?? ''} ${v.errorMessage}`);
  }
  if (v === undefined && payload.length === 0) return { kind: 'unreadable' };
  return errorFrom(v, payload);
}

/** The last line of stdout that is a JSON object: the probe scripts print their findings there. */
export function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = parseJson(lines[i]);
    if (isObject(v)) return v;
  }
  return undefined;
}
