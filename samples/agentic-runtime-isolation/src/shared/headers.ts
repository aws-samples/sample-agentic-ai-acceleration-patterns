// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Checks every ingress stage runs the same way: a case-insensitive header
 * lookup (API Gateway and the AgentCore Gateway each hand headers in the
 * client's casing) and the floor-scope test, which is AND (ADR-0005). One
 * copy, so the stages cannot drift. (v2) The v1 per-backend OR test
 * (`hasAnyScope`, ADR-0025) is gone: what a caller may do with an agent is
 * the grant rule's (src/shared/grant.ts, ADR-0030).
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
