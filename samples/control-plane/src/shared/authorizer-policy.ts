// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayAuthorizerResult } from 'aws-lambda';

/**
 * Pure helpers for the vendor IdP Lambda Authorizer. Kept free of runtime
 * dependencies (notably the ESM-only `jose`) so they are unit-testable in
 * isolation.
 */

/**
 * The two grants a verified `role` claim can map to (spec R-36, ADR-042):
 * an operator holds every operation, a reader the `GET` operations only.
 */
export type Grant = 'operator' | 'reader';

/** Every grant value, for validating the `grant` the authorizer hands on. */
export const GRANTS: readonly Grant[] = ['operator', 'reader'];

/**
 * Default allowed role set when `ALLOWED_ROLES` is not configured. The
 * dedicated control-plane issuer mints operator tokens with `role:
 * "operator"`, so the default enforces exactly that population.
 */
export const DEFAULT_ALLOWED_ROLES: readonly string[] = ['operator'];

/**
 * A role value either list may hold (spec §3.3): no comma or whitespace, so
 * it survives the comma-separated environment variable.
 */
export const ROLE_VALUE_PATTERN = /^[A-Za-z0-9:._-]{1,64}$/;

/** Splits a comma-separated role list, trimming entries and dropping empties. */
function splitRoles(name: string, raw: string): string[] {
  const roles = raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');
  if (roles.length === 0) {
    throw new Error(`${name} is set but contains no role names`);
  }
  for (const role of roles) {
    if (!ROLE_VALUE_PATTERN.test(role)) {
      throw new Error(`${name} holds a role value outside ${ROLE_VALUE_PATTERN.source}`);
    }
  }
  return roles;
}

/**
 * Parses the `ALLOWED_ROLES` environment value (comma-separated role names)
 * into the set that gets the operator grant (M13: role-claim enforcement).
 *
 * - Unset or empty → `DEFAULT_ALLOWED_ROLES` (`operator`).
 * - Set → trimmed, empty entries dropped.
 * - Set but yielding no roles (e.g. `",,"`) → throws. A deployer explicitly
 *   configured the variable and produced nothing; silently falling back to
 *   the default would widen access on a config bug, and an empty set would
 *   deny everyone without explanation. Failing fast at cold start is the
 *   fail-closed, debuggable behaviour.
 */
export function parseAllowedRoles(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set(DEFAULT_ALLOWED_ROLES);
  }
  return new Set(splitRoles('ALLOWED_ROLES', raw));
}

/**
 * Parses the `READER_ROLES` environment value into the set that gets the
 * reader grant (M26). Unlike `ALLOWED_ROLES` it has no default: unset or
 * empty means no reader is admitted. Set but yielding no names throws.
 */
export function parseReaderRoles(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set();
  }
  return new Set(splitRoles('READER_ROLES', raw));
}

/**
 * Maps each admitted role value to its grant (spec R-36). A value in both
 * lists throws, so no claim maps to two grants even when the function's
 * environment is edited after deploy.
 */
export function resolveRoleGrants(
  allowedRaw: string | undefined,
  readerRaw: string | undefined,
): ReadonlyMap<string, Grant> {
  const operators = parseAllowedRoles(allowedRaw);
  const readers = parseReaderRoles(readerRaw);
  const grants = new Map<string, Grant>();
  for (const role of operators) {
    grants.set(role, 'operator');
  }
  for (const role of readers) {
    if (grants.has(role)) {
      throw new Error(`Role value '${role}' is in both ALLOWED_ROLES and READER_ROLES`);
    }
    grants.set(role, 'reader');
  }
  return grants;
}

/**
 * A client id `clientIds` may hold (spec §3.3, R-38): Cognito's `[\w+]+`
 * plus the separators other issuers use, and no comma, so it survives the
 * comma-separated environment variable.
 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9+._:-]{1,128}$/;

/**
 * Parses `VENDOR_IDP_CLIENT_IDS` (M27): the client ids accepted on a token
 * that has no `aud`. Unset or empty means none. Set but yielding no names
 * (`",,"`), a value outside the pattern, or a duplicate throws at cold
 * start, as the role lists do.
 */
export function parseClientIds(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set();
  }
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) {
    throw new Error('VENDOR_IDP_CLIENT_IDS is set but contains no client ids');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!CLIENT_ID_PATTERN.test(id)) {
      throw new Error(`VENDOR_IDP_CLIENT_IDS holds a client id outside ${CLIENT_ID_PATTERN.source}`);
    }
    if (seen.has(id)) {
      throw new Error(`VENDOR_IDP_CLIENT_IDS lists client id '${id}' twice`);
    }
    seen.add(id);
  }
  return seen;
}

/**
 * A `requiredScope` value (spec §3.3, R-38): one RFC 6749 §3.3 scope
 * token, so no space, `"` or `\`, at most 256 characters.
 */
export const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;

/**
 * Parses `VENDOR_IDP_REQUIRED_SCOPE` (M27): the scope a token without `aud`
 * must carry. Unset or empty means none. A value outside the pattern, or a
 * scope with no client ids to apply it to, throws at cold start.
 */
export function parseRequiredScope(
  raw: string | undefined,
  clientIds: ReadonlySet<string>,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const scope = raw.trim();
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error('VENDOR_IDP_REQUIRED_SCOPE is not a single scope token');
  }
  if (clientIds.size === 0) {
    throw new Error('VENDOR_IDP_REQUIRED_SCOPE is set but VENDOR_IDP_CLIENT_IDS lists no client ids');
  }
  return scope;
}

/**
 * The audience step of spec R-38, on a payload whose signature, issuer,
 * `exp` and non-empty string `sub` are already verified. Exactly one path
 * per token, chosen by whether the `aud` key is present:
 *
 * - `aud` present, any value (`[]`, `""` and `null` included): it must
 *   equal `audience`, or be an array that contains it. Never falls back.
 * - `aud` absent: `client_id` must be a string in `clientIds` and equal
 *   `sub`, so only a listed client acting as itself passes, and a person's
 *   access token issued through that client (no `aud`, `sub` names the
 *   person) does not. When `requiredScope` is set, the space-separated
 *   `scope` claim must also hold it, so a listed client's token minted for
 *   another API on the same issuer does not pass here.
 */
export function audienceAccepted(
  payload: Readonly<Record<string, unknown>>,
  audience: string,
  clientIds: ReadonlySet<string>,
  requiredScope?: string,
): boolean {
  if (payload.aud !== undefined) {
    const aud = payload.aud;
    if (typeof aud === 'string') {
      return aud === audience;
    }
    return Array.isArray(aud) && aud.includes(audience);
  }
  const clientId = payload.client_id;
  const clientAccepted = typeof clientId === 'string'
    && clientIds.has(clientId)
    && typeof payload.sub === 'string'
    && payload.sub !== ''
    && clientId === payload.sub;
  if (!clientAccepted || requiredScope === undefined) {
    return clientAccepted;
  }
  return typeof payload.scope === 'string'
    && payload.scope.split(' ').includes(requiredScope);
}

/** Extracts the raw JWT from an `Authorization: Bearer <token>` value. */
export function extractBearerToken(authorizationToken: string | undefined): string | undefined {
  if (authorizationToken === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationToken.trim());
  return match?.[1];
}

/**
 * Builds the IAM policy for the authorizer result. The resource is widened
 * beyond the method that triggered the call so the cached result
 * (authorizer result caching keyed on the token) is valid for every
 * operation the caller may make: the whole stage for an operator or a Deny,
 * every `GET` for a reader (spec R-36). The policy depends on the grant
 * alone, never on the requested method, so a reader whose first call is a
 * write caches its read grant rather than a Deny.
 */
export function buildPolicy(
  methodArn: string,
  effect: 'Allow' | 'Deny',
  principalId: string,
  context?: Record<string, string>,
  grant: Grant = 'operator',
): APIGatewayAuthorizerResult {
  // arn:aws:execute-api:region:account:apiId/stage/METHOD/path → widen to stage/*
  const [apiGatewayArn, stage] = methodArn.split('/', 2);
  const scope = effect === 'Allow' && grant === 'reader' ? 'GET/*' : '*';
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: `${apiGatewayArn}/${stage}/${scope}`,
        },
      ],
    },
    context,
  };
}
