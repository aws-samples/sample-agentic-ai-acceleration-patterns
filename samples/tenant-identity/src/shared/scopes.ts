// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The scope rules every door shares (spec §8.1, ADR-0034, ADR-0035,
 * ADR-0036). Pure functions: no I/O, no topology. What a user holds for a
 * tenant is
 *
 *   held(user, tenant) = catalogue ∩ tenant.scopes ∩ granted(user, tenant)
 *                        ∪ { tenant-admin/users  if user is in admin-<tenant> }
 *
 * where `granted` is the user's `custom:scopes` attribute for that tenant
 * and defaults to `tenant.scopes` when the attribute (or, in topology 3,
 * the tenant's key in it) is absent. The trigger writes `held` into tokens;
 * the two user APIs show it (without the admin scope) and validate what an
 * admin may grant. The encodings of the attribute live here too, so the
 * provisioners that write it and the tenant sources that read it cannot
 * drift apart.
 */

import { INVALID_SCOPE, RESERVED_SCOPE_OWNER, SCOPE_NAME_PATTERN, SCOPE_TENANT_ADMIN, SCOPES_ATTRIBUTE_MAX_LENGTH } from './constants';
import { InvalidInputError } from './errors';

/** True when `value` is a well-formed `<owner>/<action>` scope name. */
export function isScopeName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 128 && SCOPE_NAME_PATTERN.test(value);
}

/** The owner of a scope: the text before the `/` (ADR-0034). */
export function scopeOwner(name: string): string {
  return name.slice(0, name.indexOf('/'));
}

/** True when the name's owner is reserved for the built-in scope (ADR-0034). */
export function isReservedScope(name: string): boolean {
  return scopeOwner(name) === RESERVED_SCOPE_OWNER;
}

/**
 * The fixed 400 messages (spec §5.3). Every one starts `invalid_scope` so a
 * caller can route on the prefix; none echoes the offending value.
 */
export const SCOPE_REFUSALS = {
  duplicate: `${INVALID_SCOPE}: a scope was named more than once`,
  malformed: `${INVALID_SCOPE}: a scope name does not match <owner>/<action>`,
  reservedOwner: `${INVALID_SCOPE}: the owner ${RESERVED_SCOPE_OWNER} is reserved for the built-in scope`,
  notInCatalogue: `${INVALID_SCOPE}: a scope is not registered in the catalogue`,
  notEntitled: `${INVALID_SCOPE}: a scope is not held by the tenant`,
  adminScope: `${INVALID_SCOPE}: ${SCOPE_TENANT_ADMIN} is granted by the admin group, not by a scope list`,
  tooLong: `${INVALID_SCOPE}: the granted scopes do not fit the user attribute`,
} as const;

/** Refuses a list with a duplicate or a malformed name (both doors, ADR-0034). */
function assertWellFormedList(scopes: readonly string[]): void {
  if (new Set(scopes).size !== scopes.length) {
    throw new InvalidInputError(SCOPE_REFUSALS.duplicate);
  }
  for (const scope of scopes) {
    if (!isScopeName(scope)) {
      throw new InvalidInputError(SCOPE_REFUSALS.malformed);
    }
  }
}

/**
 * A scope name a backend may register (`PutScope`, ADR-0034): well formed
 * and not under the reserved owner.
 */
export function assertRegistrableScope(name: string): void {
  if (!isScopeName(name)) {
    throw new InvalidInputError(SCOPE_REFUSALS.malformed);
  }
  if (isReservedScope(name)) {
    throw new InvalidInputError(SCOPE_REFUSALS.reservedOwner);
  }
}

/**
 * The list a tenant may be entitled to (`CreateTenant`, `UpdateTenant`,
 * ADR-0035): no duplicates, every name well formed and in the catalogue.
 * The built-in admin scope is never a tenant entitlement.
 */
export function assertTenantScopes(scopes: readonly string[], catalogue: ReadonlySet<string>): void {
  assertWellFormedList(scopes);
  for (const scope of scopes) {
    if (scope === SCOPE_TENANT_ADMIN) {
      throw new InvalidInputError(SCOPE_REFUSALS.adminScope);
    }
    if (!catalogue.has(scope)) {
      throw new InvalidInputError(SCOPE_REFUSALS.notInCatalogue);
    }
  }
}

/**
 * The list an admin may grant a user (`UpdateUser`, `UpdateTenantUser`,
 * ADR-0036): no duplicates, never the admin scope, every name in the
 * tenant's entitlement. An empty list is valid: the user then holds nothing.
 * The catalogue is not consulted here; a tenant entitlement that has since
 * left the catalogue is harmless (the trigger intersects it away) and
 * refusing it would stop an admin from cutting a user at all.
 */
export function assertGrantableScopes(scopes: readonly string[], tenantScopes: readonly string[]): void {
  assertWellFormedList(scopes);
  const entitled = new Set(tenantScopes);
  for (const scope of scopes) {
    if (scope === SCOPE_TENANT_ADMIN) {
      throw new InvalidInputError(SCOPE_REFUSALS.adminScope);
    }
    if (!entitled.has(scope)) {
      throw new InvalidInputError(SCOPE_REFUSALS.notEntitled);
    }
  }
}

/**
 * The scopes a user holds for a tenant, without the admin scope: what the
 * user APIs show as `User.scopes` (ADR-0036) and what the trigger starts
 * from (ADR-0035). `granted` undefined means the attribute (or the tenant's
 * key in it) is absent, so the user holds all of the tenant's scopes.
 * Order follows `tenantScopes`, so a listing is stable.
 */
export function effectiveScopes(
  catalogue: ReadonlySet<string>,
  tenantScopes: readonly string[],
  granted: readonly string[] | undefined,
): string[] {
  const grantedSet = granted === undefined ? undefined : new Set(granted);
  return tenantScopes.filter((scope) => catalogue.has(scope) && (grantedSet === undefined || grantedSet.has(scope)));
}

// ---------------------------------------------------------------------------
// The `custom:scopes` attribute (ADR-0036)
// ---------------------------------------------------------------------------

/**
 * Single-tenant encoding: a space-separated list. An empty list is the empty
 * string, which is a present attribute and so means "nothing", not "all".
 */
export function encodeScopeList(scopes: readonly string[]): string {
  return scopes.join(' ');
}

/** Single-tenant decoding. `undefined` (attribute absent) stays undefined. */
export function decodeScopeList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(' ').filter((s) => s.length > 0);
}

/**
 * Multi-tenant encoding (topology 3): a JSON object keyed by tenant id whose
 * values are space-separated lists, so one attribute serves every
 * membership. Starts from the attribute's current value and replaces one
 * key; a current value that is not a JSON object of strings is replaced
 * whole, never merged with.
 */
export function encodeScopeMap(current: string | undefined, tenantId: string, scopes: readonly string[]): string {
  const map = decodeScopeMap(current) ?? {};
  return JSON.stringify({ ...map, [tenantId]: encodeScopeList(scopes) });
}

/**
 * Multi-tenant decoding of the whole attribute: the object, or `undefined`
 * when the attribute is absent or is not a JSON object of strings.
 */
export function decodeScopeMap(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      return undefined;
    }
  }
  return parsed as Record<string, string>;
}

/**
 * Multi-tenant decoding for one tenant. Absent attribute or missing key:
 * `undefined` (the user holds all of the tenant's scopes). A present value
 * that is not a JSON object of strings is a write the sample never makes;
 * it is read as "nothing" for every tenant (fail closed, spec P-3) rather
 * than as "all".
 */
export function decodeScopeMapEntry(value: string | undefined, tenantId: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const map = decodeScopeMap(value);
  if (map === undefined) {
    return [];
  }
  const entry = map[tenantId];
  return entry === undefined ? undefined : decodeScopeList(entry);
}

/** Refuses an encoded attribute value Cognito would reject for its length (ADR-0036). */
export function assertAttributeFits(encoded: string): void {
  if (encoded.length > SCOPES_ATTRIBUTE_MAX_LENGTH) {
    throw new InvalidInputError(SCOPE_REFUSALS.tooLong);
  }
}
