// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The RFC 8693 token-exchange operation (spec §5.4, R-7, ADR-0009,
 * ADR-0012). It parses the form, rejects a form naming a client other than
 * the shared pool's app client where that is the only client (T-28,
 * `invalid_client`; widened for premium clients in `tiered`, ADR-0027), calls
 * `GetTokensFromRefreshToken` with the narrowing request in `ClientMetadata`
 * (the trigger does the narrowing, ADR-0010), maps Cognito's outcome to the
 * RFC 6749 §5.2 error codes, and then — because narrowing depends on
 * `ClientMetadata` reaching the trigger on refresh — decodes the returned
 * access token and refuses it unless it matches the request (ADR-0012). The
 * endpoint holds no privilege: the refresh token authorises the Cognito call
 * (P-10), so the function's role carries no `cognito-idp` permission and
 * only the one registry read the scope catalogue needs (R-7, ADR-0034).
 *
 * It never logs the refresh token, the issued token, the form, or Cognito's
 * error message (N-4, N-6): only error class names and the ADR-0012 rule
 * that refused a token.
 */

import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { assertRegisteredScopes, ExchangeRequest, OAuthFailure, OAUTH_ERROR_DESCRIPTIONS, parseExchangeForm, SERVER_UNAVAILABLE_DESCRIPTION } from './form';
import {
  COGNITO_USER_ADMIN_SCOPE,
  INVALID_SCOPE,
  INVALID_TARGET,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  TOKEN_TYPE_ACCESS,
} from '../shared/constants';
import { errorName, log } from '../shared/logger';
import type { ScopeCatalogue } from '../shared/scope-catalogue';
import { OAuthError, OAuthServerError } from '../smithy/token/typescript-ssdk-codegen/src';
import type {
  ExchangeTokenServerInput,
  ExchangeTokenServerOutput,
} from '../smithy/token/typescript-ssdk-codegen/src';

export interface TokenExchangeDeps {
  readonly cognito: CognitoIdentityProviderClient;
  /**
   * T-28: the shared pool's app client. When set, a form whose `client_id`
   * does not equal it is refused with `invalid_client` before Cognito is
   * called, unless `acceptOtherClients` is set. Undefined in pool-per-tenant,
   * where each tenant has its own client and there is no single app client to
   * compare against.
   */
  readonly appClientId?: string;
  /**
   * ADR-0027: true when the deployment creates per-tenant pools (tiered, and
   * pool-per-tenant for symmetry), so a premium tenant's own client is a valid
   * `client_id` next to the shared pool's. The check is then left to Cognito
   * and the trigger: a client of a pool the registry does not know fails the
   * trigger's pool lookup (M-5), so the refresh token buys no tenant claim.
   */
  readonly acceptOtherClients: boolean;
  /**
   * ADR-0034: the registered scope names, read through a 60 s cache. A
   * requested scope that is not registered (and is not the built-in admin
   * scope) is `invalid_scope` before Cognito is called.
   */
  readonly catalogue: ScopeCatalogue;
}

/** The minimal access-token payload shape ADR-0012 inspects. */
interface AccessTokenClaims {
  token_use?: unknown;
  tenant_id?: unknown;
  tenants?: unknown;
  scope?: unknown;
}

/**
 * Decode a JWT payload (the middle segment) as base64url JSON, without
 * verifying the signature. Safe here, and only here: the token was received
 * from Cognito over TLS in this same invocation, so its authenticity is not
 * in question — only its content (ADR-0012). Never copy this into a place
 * that receives a token from an untrusted party.
 */
function decodeAccessTokenPayload(token: string): AccessTokenClaims {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('not a three-segment JWT');
  }
  const payload = Buffer.from(segments[1], 'base64url').toString('utf8');
  return JSON.parse(payload) as AccessTokenClaims;
}

/** A client (4xx) failure -> the generated OAuthError (HTTP 400). */
function clientError(failure: OAuthFailure): OAuthError {
  return new OAuthError({
    message: failure.description,
    code: failure.code,
    description: failure.description,
  });
}

/** A server (5xx) failure -> the generated OAuthServerError (HTTP 500). */
function serverError(cause: 'mismatch' | 'unavailable' = 'mismatch'): OAuthServerError {
  const description = cause === 'unavailable' ? SERVER_UNAVAILABLE_DESCRIPTION : OAUTH_ERROR_DESCRIPTIONS.server_error;
  return new OAuthServerError({
    message: description,
    code: 'server_error',
    description,
  });
}

/**
 * Map a Cognito error to an RFC 6749 §5.2 code (spec §5.4). The trigger's
 * `invalid_target`/`invalid_scope` throws surface inside Cognito's
 * `UserLambdaValidationException` message (e.g. "PreTokenGeneration failed
 * with error invalid_target: ..."), so we inspect the message *for routing
 * only* and never log it. Throttling and 5xx become `server_error`;
 * everything else Cognito rejects is `invalid_grant`.
 */
function mapCognitoError(error: unknown): OAuthError | OAuthServerError {
  const name = errorName(error);
  const message = error instanceof Error ? error.message : '';

  // Only the trigger's own refusal may route on its message: another
  // exception whose text happens to contain the prefix is not a trigger
  // verdict (spec §5.4).
  if (name === 'UserLambdaValidationException') {
    if (message.includes(INVALID_TARGET)) {
      return clientError(new OAuthFailure('invalid_target'));
    }
    if (message.includes(INVALID_SCOPE)) {
      return clientError(new OAuthFailure('invalid_scope'));
    }
  }

  switch (name) {
    case 'NotAuthorizedException':
    case 'InvalidParameterException':
    case 'ResourceNotFoundException':
    case 'UserNotFoundException':
    case 'RefreshTokenReuseException':
    case 'ForbiddenException':
      return clientError(new OAuthFailure('invalid_grant'));
    // spec §5.4: a UserLambdaValidationException that carried neither the
    // invalid_target nor the invalid_scope prefix (checked above) is the
    // trigger failing for a non-caller reason — a registry outage, not a bad
    // grant. Map it to server_error so the client retries rather than
    // discarding a still-valid refresh token. Log the class name only (N-6).
    case 'UserLambdaValidationException':
      log.error('exchange trigger fault', { errorName: name });
      return serverError('unavailable');
    // Throttling and server faults: the request may succeed on retry, so this
    // is a 500, not a client error (documented choice, spec §5.4 N-6).
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'InternalErrorException':
      log.error('exchange cognito fault', { errorName: name });
      return serverError('unavailable');
    default:
      // An unmodelled client error from Cognito is still the caller's grant
      // problem; an unknown fault we treat conservatively as invalid_grant
      // unless the SDK marks it a server fault.
      if (isServerFault(error)) {
        log.error('exchange cognito fault', { errorName: name });
        return serverError('unavailable');
      }
      return clientError(new OAuthFailure('invalid_grant'));
  }
}

/** True when the SDK metadata marks the error a 5xx server fault. */
function isServerFault(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const fault = (error as { $fault?: string })?.$fault;
  return fault === 'server' || (typeof status === 'number' && status >= 500);
}

/**
 * ADR-0012: confirm Cognito actually narrowed the token. Refuse unless:
 * token_use is 'access'; tenant_id equals the requested tenant when one was
 * requested; there is no `tenants` claim; and the scope set equals the
 * requested set (order-insensitive). On any mismatch, log the failed rule
 * name only and throw server_error — the token is discarded.
 */
function assertNarrowed(claims: AccessTokenClaims, request: ExchangeRequest): void {
  const refuse = (rule: string): never => {
    log.error('exchange token did not match request', { rule });
    throw serverError();
  };

  if (claims.token_use !== 'access') {
    refuse('token_use!=access');
  }
  if ('tenants' in claims && claims.tenants !== undefined) {
    refuse('tenants-claim-present');
  }
  if (typeof claims.tenant_id !== 'string') {
    refuse('tenant_id-missing');
  }
  if (request.tenantId !== undefined && claims.tenant_id !== request.tenantId) {
    refuse('tenant_id-mismatch');
  }
  const tokenScopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter((s) => s.length > 0) : [];
  const tokenSet = new Set(tokenScopes);
  const requestSet = new Set(request.scopes);
  // A narrowed token never carries the Cognito admin scope; an un-narrowed
  // one always does, so this comparison catches it in every topology.
  if (tokenSet.has(COGNITO_USER_ADMIN_SCOPE)) {
    refuse('cognito-admin-scope-present');
  }
  if (tokenSet.size !== requestSet.size) {
    refuse('scope-set-mismatch');
  }
  for (const s of requestSet) {
    if (!tokenSet.has(s)) {
      refuse('scope-set-mismatch');
    }
  }
}

export class TokenExchangeService<Context> {
  private readonly cognito: CognitoIdentityProviderClient;
  private readonly appClientId: string | undefined;
  private readonly acceptOtherClients: boolean;
  private readonly catalogue: ScopeCatalogue;

  constructor(deps: TokenExchangeDeps) {
    this.cognito = deps.cognito;
    this.appClientId = deps.appClientId;
    this.acceptOtherClients = deps.acceptOtherClients;
    this.catalogue = deps.catalogue;
  }

  public ExchangeToken = async (
    input: ExchangeTokenServerInput,
    _context: Context,
  ): Promise<ExchangeTokenServerOutput> => {
    // 1. Parse the form. OAuthFailure -> the generated OAuthError (400).
    // The form is validated in full before anything is read: a malformed
    // request on this unauthenticated endpoint costs no catalogue lookup.
    let request: ExchangeRequest;
    try {
      // `form` is @required; the generated validator guarantees it is set.
      request = parseExchangeForm(input.form ?? new Uint8Array());
    } catch (error) {
      if (error instanceof OAuthFailure) {
        throw clientError(error);
      }
      // A parser bug, not caller input.
      log.error('exchange form parse failed', { errorName: errorName(error) });
      throw serverError();
    }

    // 1b. The one registry-backed check (ADR-0034): every requested scope is
    // registered, or the built-in admin scope. The catalogue read never
    // throws (a failed read keeps the last one) and is served from the
    // container cache after cold start.
    try {
      assertRegisteredScopes(request.scopes, await this.catalogue.names());
    } catch (error) {
      if (error instanceof OAuthFailure) {
        throw clientError(error);
      }
      throw error;
    }

    // T-28: in a shared pool, this endpoint serves exactly one app client.
    // Refuse a form naming a different client with invalid_client, before
    // Cognito is called. Skipped in pool-per-tenant (appClientId undefined),
    // where each tenant has its own client, and in tiered (acceptOtherClients),
    // where a premium tenant's client is as valid as the shared pool's. A
    // foreign client is then refused by the trigger instead: its pool is not
    // in the registry, so no token with a tenant claim is issued (M-5).
    if (this.appClientId !== undefined && request.clientId !== this.appClientId && !this.acceptOtherClients) {
      throw clientError(new OAuthFailure('invalid_client'));
    }

    // 2. Ask Cognito, passing the narrowing request in ClientMetadata. Always
    // set the scope key so the trigger always narrows (never widens, P-10).
    const clientMetadata: Record<string, string> = {
      [NARROW_SCOPE_KEY]: request.scopes.join(' '),
    };
    if (request.tenantId !== undefined) {
      clientMetadata[NARROW_TENANT_KEY] = request.tenantId;
    }

    let response;
    try {
      response = await this.cognito.send(
        new GetTokensFromRefreshTokenCommand({
          ClientId: request.clientId,
          RefreshToken: request.refreshToken,
          ClientMetadata: clientMetadata,
        }),
      );
    } catch (error) {
      throw mapCognitoError(error);
    }

    const result = response.AuthenticationResult;
    const accessToken = result?.AccessToken;
    if (accessToken === undefined || result === undefined) {
      log.error('exchange cognito returned no access token', {});
      throw serverError();
    }

    // 3. ADR-0012: decode and check the token matches the request. Discard
    // the ID token and any refresh token by never reading them.
    let claims: AccessTokenClaims;
    try {
      claims = decodeAccessTokenPayload(accessToken);
    } catch (error) {
      log.error('exchange token payload undecodable', { errorName: errorName(error) });
      throw serverError();
    }
    assertNarrowed(claims, request);

    // 4. Success. Cache-Control: no-store (RFC 6749 §5.1). The scope echoed
    // back is the requested set, which assertNarrowed proved equals the
    // token's scope.
    return {
      cacheControl: 'no-store',
      accessToken,
      issuedTokenType: TOKEN_TYPE_ACCESS,
      tokenType: 'Bearer',
      expiresIn: result.ExpiresIn ?? 0,
      scope: request.scopes.join(' '),
    };
  };
}
