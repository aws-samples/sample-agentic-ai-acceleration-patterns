// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The RFC 8693 §2.1 form parser (spec §5.4, ADR-0011). It is the only code
 * that reads caller input on the unauthenticated token-exchange route, so it
 * is strict: it accepts exactly the parameters §5.4 lists, rejects every
 * other RFC 8693 parameter, rejects any repeated parameter (RFC 6749 §3.2),
 * and rejects any unknown parameter. On any failure it throws `OAuthFailure`,
 * whose `description` is fixed text per code and never echoes the input
 * (spec §5.4: `error_description` never echoes Cognito's message or a token).
 */

import {
  ALL_SCOPES,
  GRANT_TYPE_TOKEN_EXCHANGE,
  TENANT_RESOURCE_PREFIX,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_REFRESH,
  ULID_PATTERN,
} from '../shared/constants';

/** RFC 6749 §5.2 error codes the parser can raise. */
export type OAuthErrorCodeValue =
  | 'invalid_request'
  | 'unsupported_grant_type'
  | 'invalid_target'
  | 'invalid_scope'
  | 'invalid_grant'
  | 'server_error';

/**
 * Fixed `error_description` text per code. The text is deliberately generic:
 * it describes the class of failure and never repeats a value the caller
 * sent, so no token, scope, or Cognito message can leak through it.
 */
export const OAUTH_ERROR_DESCRIPTIONS: Record<OAuthErrorCodeValue, string> = {
  invalid_request:
    'The request is missing a required parameter, includes an unsupported or repeated parameter, or is otherwise malformed.',
  unsupported_grant_type: 'The grant_type is not supported by this endpoint.',
  invalid_target: 'The requested tenant is not available to this subject token.',
  invalid_scope: 'The requested scope is invalid or exceeds the subject token.',
  invalid_grant: 'The provided refresh token is invalid, expired, or revoked.',
  server_error: 'The authorization server returned a token that does not match the request.',
};

/**
 * `server_error` text when Cognito throttled or failed, not when it returned
 * the wrong token: the caller may retry (spec §5.4).
 */
export const SERVER_UNAVAILABLE_DESCRIPTION = 'The authorization server is temporarily unable to handle the request; retry later.';

/**
 * A form-validation or exchange failure. Carries a code and the fixed
 * description for that code; the message is the description, so nothing a
 * caller supplied ever appears in it.
 */
export class OAuthFailure extends Error {
  public readonly code: OAuthErrorCodeValue;
  public readonly description: string;

  constructor(code: OAuthErrorCodeValue) {
    const description = OAUTH_ERROR_DESCRIPTIONS[code];
    super(description);
    this.name = 'OAuthFailure';
    this.code = code;
    this.description = description;
    Object.setPrototypeOf(this, OAuthFailure.prototype);
  }
}

/** The parsed, validated request (spec §5.4). */
export interface ExchangeRequest {
  readonly clientId: string;
  readonly refreshToken: string;
  /** Present only when a `resource` was supplied; the ULID of the tenant. */
  readonly tenantId?: string;
  /** Non-empty, de-duplicated, every entry in ALL_SCOPES. */
  readonly scopes: string[];
}

/**
 * The only RFC 8693 parameters §5.4 recognises. `audience`, `actor_token`,
 * and `actor_token_type` are RFC 8693 parameters we deliberately refuse, so
 * they are listed here but rejected in the body (a clearer failure than
 * "unknown parameter"). Any name not in this set is an unknown parameter.
 */
const KNOWN_PARAMETERS = new Set<string>([
  'grant_type',
  'client_id',
  'subject_token',
  'subject_token_type',
  'requested_token_type',
  'resource',
  'scope',
  'audience',
  'actor_token',
  'actor_token_type',
]);

/** RFC 8693 parameters §5.4 refuses outright. */
const REFUSED_PARAMETERS = new Set<string>(['audience', 'actor_token', 'actor_token_type']);

function invalidRequest(): never {
  throw new OAuthFailure('invalid_request');
}

/**
 * Parse and validate the form body. `body` is the raw request payload: a
 * Uint8Array as delivered by the generated deserializer, or a string in
 * tests. Throws `OAuthFailure` on any violation.
 */
export function parseExchangeForm(body: Uint8Array | string): ExchangeRequest {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);

  const params = new URLSearchParams(text);

  // RFC 6749 §3.2: request parameters MUST NOT be included more than once,
  // and (spec §5.4) any unknown parameter is rejected. Walk the raw pairs so
  // a repeat is detected even for a known key.
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!KNOWN_PARAMETERS.has(key)) {
      invalidRequest();
    }
    if (seen.has(key)) {
      invalidRequest();
    }
    seen.add(key);
  }

  // Refused RFC 8693 parameters (spec §5.4).
  for (const refused of REFUSED_PARAMETERS) {
    if (params.has(refused)) {
      invalidRequest();
    }
  }

  // grant_type: missing -> invalid_request; present but wrong ->
  // unsupported_grant_type (spec §5.4).
  const grantType = params.get('grant_type');
  if (grantType === null) {
    invalidRequest();
  }
  if (grantType !== GRANT_TYPE_TOKEN_EXCHANGE) {
    throw new OAuthFailure('unsupported_grant_type');
  }

  // client_id and subject_token are required.
  const clientId = params.get('client_id');
  if (clientId === null || clientId === '') {
    invalidRequest();
  }
  const subjectToken = params.get('subject_token');
  if (subjectToken === null || subjectToken === '') {
    invalidRequest();
  }

  // subject_token_type MUST be the refresh-token URN.
  const subjectTokenType = params.get('subject_token_type');
  if (subjectTokenType !== TOKEN_TYPE_REFRESH) {
    invalidRequest();
  }

  // requested_token_type is optional; if present it MUST be the access-token
  // URN.
  const requestedTokenType = params.get('requested_token_type');
  if (requestedTokenType !== null && requestedTokenType !== TOKEN_TYPE_ACCESS) {
    invalidRequest();
  }

  // resource: at most one (a repeat is already caught above), and it MUST be
  // the tenant resource prefix plus a ULID.
  let tenantId: string | undefined;
  const resource = params.get('resource');
  if (resource !== null) {
    if (!resource.startsWith(TENANT_RESOURCE_PREFIX)) {
      invalidRequest();
    }
    const candidate = resource.slice(TENANT_RESOURCE_PREFIX.length);
    if (!ULID_PATTERN.test(candidate)) {
      invalidRequest();
    }
    tenantId = candidate;
  }

  // scope: required, space-separated, non-empty, each in ALL_SCOPES, no
  // duplicates (spec §5.4).
  const scope = params.get('scope');
  if (scope === null) {
    invalidRequest();
  }
  const scopes = scope.split(' ').filter((s) => s.length > 0);
  if (scopes.length === 0) {
    invalidRequest();
  }
  const scopeSet = new Set<string>();
  for (const s of scopes) {
    if (!ALL_SCOPES.includes(s)) {
      // An out-of-vocabulary scope is a scope problem, not a malformed form.
      throw new OAuthFailure('invalid_scope');
    }
    if (scopeSet.has(s)) {
      invalidRequest();
    }
    scopeSet.add(s);
  }

  return {
    clientId: clientId as string,
    refreshToken: subjectToken as string,
    ...(tenantId !== undefined ? { tenantId } : {}),
    scopes,
  };
}
