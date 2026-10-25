// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantidentity

use aws.apigateway#integration
use aws.apigateway#requestValidator
use aws.protocols#restJson1

/// OAuth 2.0 Token Exchange (RFC 8693) with Cognito as the signer
/// (spec §5.4, ADR-0009). No gateway authoriser: the refresh token in the
/// body is the credential, and Cognito validates it.
@title("Tenant Identity - Token Exchange")
@restJson1
@integration(type: "aws_proxy", httpMethod: "POST", uri: "PLACEHOLDER")
service TokenService {
    version: "2026-10-21"
    operations: [
        ExchangeToken
    ]
}

/// The RFC 8693 §2.1 request, form-encoded (ADR-0011). Parameters:
/// grant_type (urn:ietf:params:oauth:grant-type:token-exchange), client_id,
/// subject_token (a refresh token), subject_token_type
/// (urn:ietf:params:oauth:token-type:refresh_token), requested_token_type
/// (optional, access_token only), resource (urn:tenant-identity:tenant:<ULID>,
/// at most one), scope (required, space-separated). audience, actor_token
/// and actor_token_type are refused.
@mediaType("application/x-www-form-urlencoded")
blob TokenExchangeForm

/// Narrows a refresh token's session to one tenant and a subset of scopes.
/// Returns an access token only.
@auth([])
// Body validation does not apply to a form body; the function parses it.
@requestValidator("params-only")
@http(method: "POST", uri: "/oauth2/token", code: 200)
operation ExchangeToken {
    input := {
        @required
        @httpPayload
        form: TokenExchangeForm
    }

    output := {
        /// Always `no-store` (RFC 6749 §5.1).
        @required
        @httpHeader("Cache-Control")
        cacheControl: String

        @required
        @jsonName("access_token")
        accessToken: TokenValue

        @required
        @jsonName("issued_token_type")
        issuedTokenType: String

        @required
        @jsonName("token_type")
        tokenType: String

        @required
        @jsonName("expires_in")
        expiresIn: Integer

        @required
        scope: String
    }

    errors: [
        OAuthError
        OAuthServerError
    ]
}

/// RFC 6749 §5.2 error codes used by the exchange.
enum OAuthErrorCode {
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_GRANT_TYPE = "unsupported_grant_type"
    INVALID_TARGET = "invalid_target"
    INVALID_SCOPE = "invalid_scope"
    INVALID_GRANT = "invalid_grant"
    INVALID_CLIENT = "invalid_client"
    SERVER_ERROR = "server_error"
}

/// An RFC 6749 §5.2 error. `error_description` is fixed text per code and
/// never echoes Cognito's message or a token.
@error("client")
@httpError(400)
structure OAuthError {
    @required
    @jsonName("error")
    code: OAuthErrorCode

    @required
    @jsonName("error_description")
    description: String
}

/// Cognito returned a token that does not match the request (ADR-0012).
@error("server")
@httpError(500)
structure OAuthServerError {
    @required
    @jsonName("error")
    code: OAuthErrorCode

    @required
    @jsonName("error_description")
    description: String
}
