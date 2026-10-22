// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import {
  adminGroupName,
  API_SCOPES,
  COGNITO_USER_ADMIN_SCOPE,
  INVALID_SCOPE,
  INVALID_TARGET,
  isTenantId,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  SCOPE_TENANT_ADMIN,
} from '../shared/constants';
import { log } from '../shared/logger';
import type { RegistryReader, TenantRecord } from '../shared/registry';
import type { ResolvedTenants, TenantSource } from '../topology/provisioner';

/**
 * The pre-token-generation trigger core (spec §8, ADR-0003, ADR-0008,
 * ADR-0010, ADR-0015). A pure function of the event and the registry's
 * current state: it reads, it never writes (§8 "Idempotency"). It is the
 * only code that decides what tenant identity a token carries.
 *
 * The trigger role holds no `cognito-idp` permission (R-14): every Cognito
 * fact it needs is already in the event (`groupConfiguration.groupsToOverride`,
 * `userAttributes`) or in the registry (status).
 *
 * Refusals throw an `Error` whose message begins exactly `invalid_target: `
 * or `invalid_scope: ` followed by fixed text. The text never echoes the
 * caller's input, so the token-exchange function can map the error by prefix
 * (ADR-0010, §5.4) without leaking what was asked for. Every other failure
 * (an unknown pool, a registry outage) propagates unchanged; the function
 * never swallows an error and returns a token without the tenant claim, which
 * the contract (P-6) does not allow.
 *
 * ## Documented choice: duplicate scopes are refused
 *
 * §8.2 leaves "no duplicates allowed or dedupe" to the implementer. This
 * core *refuses* a scope list that contains a duplicate with `invalid_scope`.
 * The narrowed token must be *exactly* the request (ADR-0010); a request that
 * names the same scope twice is not a clean subset expression, and refusing
 * it keeps the "output equals the request" property unambiguous. The
 * exchange's own check (ADR-0012) compares scope *sets*, so a dedupe would
 * also pass there, but refusing surfaces the malformed request to the caller
 * rather than silently reshaping it.
 */

const STATUS_ACTIVE = 'ACTIVE';

/** Fixed refusal text. Never contains caller input (ADR-0010, §5.4). */
const TARGET_NOT_HELD = `${INVALID_TARGET}: requested tenant is not an active tenant of the user`;
const TARGET_MISSING_MULTI = `${INVALID_TARGET}: a tenant must be named when the user holds more than one`;
const TARGET_MALFORMED = `${INVALID_TARGET}: requested tenant is not a valid identifier`;
// Status refusals carry the same prefix, so the exchange maps an inactive or
// absent tenant to invalid_target (§5.4), not invalid_grant.
/**
 * Cognito writes `cognito:groups` into the access token as well as the ID
 * token. The groups name every tenant (`t-<id>`) and admin role
 * (`admin-<id>`) the user holds, so leaving them would undo narrowing and
 * break the P-6 contract. Every token overrides them with none (ADR-0020).
 */
const NO_GROUPS = { groupsToOverride: [] as string[] };
const TARGET_NOT_ACTIVE = `${INVALID_TARGET}: tenant is not active`;
const TARGET_NONE_ACTIVE = `${INVALID_TARGET}: user has no active tenant`;
const SCOPE_EMPTY = `${INVALID_SCOPE}: at least one scope must be requested`;
const SCOPE_DUPLICATE = `${INVALID_SCOPE}: a scope was requested more than once`;
const SCOPE_NOT_HELD = `${INVALID_SCOPE}: a requested scope is not held for the requested tenant`;

export interface PreTokenGenerationDeps {
  readonly source: TenantSource;
  readonly registry: RegistryReader;
}

/** A narrowing request read from the two §8.2 keys only. */
interface NarrowRequest {
  /** `undefined` when the tenant key was absent (topologies 1, 2 only). */
  readonly tenantId: string | undefined;
  readonly scopes: string[];
}

/**
 * Resolves, applies status rules, then either narrows or emits the
 * un-narrowed token. Returns the same event object with
 * `response.claimsAndScopeOverrideDetails` populated.
 */
export async function handlePreTokenGeneration(
  event: PreTokenGenerationV2TriggerEvent,
  deps: PreTokenGenerationDeps,
): Promise<PreTokenGenerationV2TriggerEvent> {
  const sub = event.request.userAttributes?.sub;
  const logBase = { triggerSource: event.triggerSource, userName: event.userName, sub };

  // 1. Resolve the user's tenants for this event (topology-specific; §8).
  const resolved = await deps.source.resolve(event, deps.registry);

  // 2. Apply the status rules (P-2, ADR-0008). Produces the ACTIVE set.
  const active = activeTenants(resolved, logBase);

  // 3. Read ONLY the two §8.2 narrowing keys. No other clientMetadata key is
  //    read: nothing the caller supplies can add a tenant or a scope (P-3).
  const narrow = readNarrowRequest(event.request.clientMetadata);

  if (narrow !== undefined) {
    return applyNarrowing(event, resolved, active, narrow, logBase);
  }

  return applyUnNarrowed(event, resolved, active, logBase);
}

/**
 * Applies the status rule (§8 "Status rule"):
 * - single (1, 2): record absent or not ACTIVE -> throw.
 * - multi (3): drop every absent or non-ACTIVE tenant; none left -> throw.
 * Returns the list of ACTIVE tenant records.
 */
function activeTenants(
  resolved: ResolvedTenants,
  logBase: Record<string, string | undefined>,
): TenantRecord[] {
  if (resolved.kind === 'single') {
    const record = resolved.record;
    if (record === undefined || record.status !== STATUS_ACTIVE) {
      log.warn('pre-token-generation refused: tenant not active', {
        ...logBase,
        rule: 'status-single',
        tenantId: resolved.tenantId,
      });
      throw new Error(TARGET_NOT_ACTIVE);
    }
    return [record];
  }

  const active = resolved.records.filter((r) => r.status === STATUS_ACTIVE);
  if (active.length === 0) {
    log.warn('pre-token-generation refused: no active tenant', {
      ...logBase,
      rule: 'status-multi',
    });
    throw new Error(TARGET_NONE_ACTIVE);
  }
  return active;
}

/**
 * Reads the narrowing request from the two §8.2 keys only. Returns
 * `undefined` when neither key is present (no narrowing). `clientMetadata`
 * may be undefined (§8).
 */
function readNarrowRequest(clientMetadata: Record<string, string> | undefined): NarrowRequest | undefined {
  if (clientMetadata === undefined) {
    return undefined;
  }
  const tenantValue = clientMetadata[NARROW_TENANT_KEY];
  const scopeValue = clientMetadata[NARROW_SCOPE_KEY];
  if (tenantValue === undefined && scopeValue === undefined) {
    return undefined;
  }
  // Split on spaces; drop empty segments produced by runs of whitespace.
  const scopes = (scopeValue ?? '').split(' ').filter((s) => s.length > 0);
  return { tenantId: tenantValue, scopes };
}

/**
 * Narrowing (§8.2, ADR-0010). The request is caller input and is intersected
 * with what the user holds; the result is exactly the request or nothing.
 */
function applyNarrowing(
  event: PreTokenGenerationV2TriggerEvent,
  resolved: ResolvedTenants,
  active: TenantRecord[],
  narrow: NarrowRequest,
  logBase: Record<string, string | undefined>,
): PreTokenGenerationV2TriggerEvent {
  // Resolve which tenant was requested.
  const target = resolveNarrowTenant(resolved, active, narrow.tenantId, logBase);

  // Scopes: non-empty, no duplicates, each held for the target tenant.
  const requested = narrow.scopes;
  if (requested.length === 0) {
    refuse(SCOPE_EMPTY, 'narrow-scope-empty', { ...logBase, tenantId: target.tenantId });
  }
  if (new Set(requested).size !== requested.length) {
    refuse(SCOPE_DUPLICATE, 'narrow-scope-duplicate', { ...logBase, tenantId: target.tenantId });
  }

  const held = scopesHeldFor(event, target.tenantId);
  for (const scope of requested) {
    if (!held.has(scope)) {
      refuse(SCOPE_NOT_HELD, 'narrow-scope-not-held', { ...logBase, tenantId: target.tenantId });
    }
  }

  log.info('pre-token-generation narrowed', { ...logBase, tenantId: target.tenantId });

  // Output: tenant_id = requested, scopes = exactly the requested set. M-13:
  // a narrowed token must be *exactly* the request (ADR-0010, ADR-0012), so
  // suppress every scope the incoming token already carries that is not in
  // the requested set, plus Cognito's own user-admin scope (deduplicated).
  // OAuth scopes are off in this sample today, but if a deployment turned
  // them on the base scopes on the refresh token must not survive narrowing.
  const requestedSet = new Set(requested);
  const incomingScopes = event.request.scopes ?? [];
  const scopesToSuppress = [
    ...new Set([
      ...incomingScopes.filter((s) => !requestedSet.has(s)),
      COGNITO_USER_ADMIN_SCOPE,
    ]),
  ];
  // No `tenants` claim (P-6, §8).
  event.response.claimsAndScopeOverrideDetails = {
    accessTokenGeneration: {
      claimsToAddOrOverride: { tenant_id: target.tenantId },
      scopesToAdd: [...requested],
      scopesToSuppress,
    },
    groupOverrideDetails: NO_GROUPS,
  };
  return event;
}

/**
 * Resolves the narrowed tenant from the request's tenant key (§8.2 rule 1):
 * - missing key, single topology: the user's only tenant.
 * - missing key, multi topology: invalid_target.
 * - present: must be a ULID and in the ACTIVE set.
 */
function resolveNarrowTenant(
  resolved: ResolvedTenants,
  active: TenantRecord[],
  tenantKey: string | undefined,
  logBase: Record<string, string | undefined>,
): TenantRecord {
  if (tenantKey === undefined) {
    if (resolved.kind === 'single') {
      // active always has exactly one record for a single topology here.
      return active[0];
    }
    refuse(TARGET_MISSING_MULTI, 'narrow-target-missing', logBase);
  }

  if (!isTenantId(tenantKey)) {
    // Do not log the malformed value; log only that the rule fired.
    refuse(TARGET_MALFORMED, 'narrow-target-malformed', logBase);
  }

  const match = active.find((r) => r.tenantId === tenantKey);
  if (match === undefined) {
    refuse(TARGET_NOT_HELD, 'narrow-target-not-held', { ...logBase, tenantId: tenantKey });
  }
  return match;
}

/**
 * The scopes the user holds for a tenant (§8.1): the two API scopes for every
 * member, plus `tenant-admin/users` only if the user is in `admin-<tenant>`.
 * Membership comes from the event's groups, never from caller input.
 */
function scopesHeldFor(event: PreTokenGenerationV2TriggerEvent, tenantId: string): Set<string> {
  const held = new Set<string>(API_SCOPES);
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  if (groups.includes(adminGroupName(tenantId))) {
    held.add(SCOPE_TENANT_ADMIN);
  }
  return held;
}

/**
 * The un-narrowed token (§8 "Output"): `tenant_id` for single topologies,
 * `tenants` (sorted) for multi; API scopes only, never `tenant-admin/users`.
 */
function applyUnNarrowed(
  event: PreTokenGenerationV2TriggerEvent,
  resolved: ResolvedTenants,
  active: TenantRecord[],
  logBase: Record<string, string | undefined>,
): PreTokenGenerationV2TriggerEvent {
  if (resolved.kind === 'single') {
    const tenantId = active[0].tenantId;
    log.info('pre-token-generation issued', { ...logBase, tenantId });
    event.response.claimsAndScopeOverrideDetails = {
      accessTokenGeneration: {
        claimsToAddOrOverride: { tenant_id: tenantId },
        scopesToAdd: [...API_SCOPES],
      },
      groupOverrideDetails: NO_GROUPS,
    };
    return event;
  }

  // Sorted array of ULIDs (P-6). V2 events accept arrays as claim values;
  // @types/aws-lambda types the map as strings only, hence the cast.
  const tenants = active.map((r) => r.tenantId).sort();
  log.info('pre-token-generation issued', { ...logBase, tenantId: tenants.join(',') });
  event.response.claimsAndScopeOverrideDetails = {
    accessTokenGeneration: {
      claimsToAddOrOverride: { tenants } as unknown as Record<string, string>,
      scopesToAdd: [...API_SCOPES],
    },
    groupOverrideDetails: NO_GROUPS,
  };
  return event;
}

/** Logs the rule that refused, then throws with the fixed prefixed message. */
function refuse(
  message: string,
  rule: string,
  logBase: Record<string, string | undefined>,
): never {
  log.warn('pre-token-generation refused', { ...logBase, rule });
  throw new Error(message);
}
