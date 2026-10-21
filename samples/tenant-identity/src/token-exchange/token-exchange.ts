// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The RFC 8693 token-exchange operation (spec §5.4, R-7, ADR-0009,
 * ADR-0012). It parses the form, calls `GetTokensFromRefreshToken` with the
 * narrowing request in `ClientMetadata` (the trigger does the narrowing,
 * ADR-0010), maps Cognito's outcome to the RFC 6749 §5.2 error codes, and
 * then — because narrowing depends on `ClientMetadata` reaching the trigger
 * on refresh — decodes the returned access token and refuses it unless it
 * matches the request (ADR-0012). The endpoint holds no privilege: the
 * refresh token authorises the Cognito call (P-10), so the function's role
 * carries no `cognito-idp` or DynamoDB permission (R-7).
 *
 * It never logs the refresh token, the issued token, the form, or Cognito's
 * error message (N-4, N-6): only error class names and the ADR-0012 rule
 * that refused a token.
 */

import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ExchangeRequest, OAuthFailure, OAUTH_ERROR_DESCRIPTIONS, parseExchangeForm } from './form';
import {
  COGNITO_USER_ADMIN_SCOPE,
  INVALID_SCOPE,
  INVALID_TARGET,
  NARROW_SCOPE_KEY,
  NARROW_TENANT_KEY,
  TOKEN_TYPE_ACCESS,
} from '../shared/constants';
import { errorName, log } from '../shared/logger';
import { OAuthError, OAuthServerError } from '../smithy/token/typescript-ssdk-codegen/src';
import type {
  ExchangeTokenServerInput,
  ExchangeTokenServerOutput,
} from '../smithy/token/typescript-ssdk-codegen/src';

export interface TokenExchangeDeps {
  readonly cognito: CognitoIdentityProviderClient;
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
function serverError(): OAuthServerError {
  const description = OAUTH_ERROR_DESCRIPTIONS.server_error;
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

  if (message.includes(INVALID_TARGET)) {
    return clientError(new OAuthFailure('invalid_target'));
  }
  if (message.includes(INVALID_SCOPE)) {
    return clientError(new OAuthFailure('invalid_scope'));
  }

  switch (name) {
    case 'NotAuthorizedException':
    case 'InvalidParameterException':
    case 'ResourceNotFoundException':
    case 'UserNotFoundException':
    case 'RefreshTokenReuseException':
    case 'ForbiddenException':
    case 'UserLambdaValidationException':
      return clientError(new OAuthFailure('invalid_grant'));
    // Throttling and server faults: the request may succeed on retry, so this
    // is a 500, not a client error (documented choice, spec §5.4 N-6).
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'InternalErrorException':
      log.error('exchange cognito fault', { errorName: name });
      return serverError();
    default:
      // An unmodelled client error from Cognito is still the caller's grant
      // problem; an unknown fault we treat conservatively as invalid_grant
      // unless the SDK marks it a server fault.
      if (isServerFault(error)) {
        log.error('exchange cognito fault', { errorName: name });
        return serverError();
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

  constructor(deps: TokenExchangeDeps) {
    this.cognito = deps.cognito;
  }

  public ExchangeToken = async (
    input: ExchangeTokenServerInput,
    _context: Context,
  ): Promise<ExchangeTokenServerOutput> => {
    // 1. Parse the form. OAuthFailure -> the generated OAuthError (400).
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
