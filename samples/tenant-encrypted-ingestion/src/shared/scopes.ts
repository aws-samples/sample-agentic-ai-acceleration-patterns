// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Scope-name helpers for the scope registration (copied from
 * agentic-runtime-isolation's src/shared/registry.ts, its ADR-0025). A scope
 * name is `<owner>/<action>` as tenant-identity's catalogue accepts it; this
 * sample owns `ingestion/deliver` and `ingestion/read` (spec §3.2).
 */

export const SCOPE_NAME_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const SCOPE_NAME_MIN_LENGTH = 3;
export const SCOPE_NAME_MAX_LENGTH = 128;

/** Whether `scope` is a scope name the identity provider accepts. */
export function isValidScopeName(scope: unknown): scope is string {
  return (
    typeof scope === 'string' &&
    scope.length >= SCOPE_NAME_MIN_LENGTH &&
    scope.length <= SCOPE_NAME_MAX_LENGTH &&
    SCOPE_NAME_PATTERN.test(scope)
  );
}

/** The owner of a scope name: the text before the slash. */
export function scopeOwner(scope: string): string {
  return scope.split('/')[0];
}

/**
 * Checks a scope list at synth: at least one, no duplicates, each a valid
 * scope name owned by `backend`. Returns the problem, or undefined.
 */
export function backendScopesProblem(backend: string, scopes: readonly string[]): string | undefined {
  if (scopes.length === 0) {
    return 'must name at least one scope';
  }
  for (const scope of scopes) {
    if (!isValidScopeName(scope)) {
      return `'${scope}' must match ${SCOPE_NAME_PATTERN.source} and be ${SCOPE_NAME_MIN_LENGTH} to ${SCOPE_NAME_MAX_LENGTH} characters`;
    }
    if (scopeOwner(scope) !== backend) {
      return `'${scope}' must be owned by ${backend}: ${backend}/<action>`;
    }
  }
  if (new Set(scopes).size !== scopes.length) {
    return 'must not repeat a scope';
  }
  return undefined;
}
