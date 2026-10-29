// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Two checks every ingress stage runs the same way: a case-insensitive
 * header lookup (API Gateway and the AgentCore Gateway each hand headers
 * in the client's casing) and the two scope tests shared by the authoriser
 * and the pipeline: the ingress-wide floor is AND (ADR-0005), a backend's
 * own scopes are OR (ADR-0025). One copy, so the stages cannot drift.
 */

/** The first header whose name matches `name` case-insensitively, else undefined. */
export function headerValue(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (headers === undefined || headers === null) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** The required scopes the granted list lacks; empty when every one is present (AND). */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  return required.filter((scope) => !granted.includes(scope));
}

/**
 * Whether the granted list carries at least one of the backend's scopes
 * (OR, ADR-0025). An empty `required` list is false: a backend that names
 * no scope admits no token (fail closed), where `AgentBackend` refuses the
 * empty list at synth and only a hand-written registry entry can carry it.
 */
export function hasAnyScope(granted: readonly string[], required: readonly string[]): boolean {
  return required.some((scope) => granted.includes(scope));
}
