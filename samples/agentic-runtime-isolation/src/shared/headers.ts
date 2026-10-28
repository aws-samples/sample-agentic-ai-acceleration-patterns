// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Two checks every ingress stage runs the same way: a case-insensitive
 * header lookup (API Gateway and the AgentCore Gateway each hand headers
 * in the client's casing) and the scope test shared by the authoriser and
 * the pipeline (ADR-0005, ADR-0024). One copy, so the stages cannot drift.
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
