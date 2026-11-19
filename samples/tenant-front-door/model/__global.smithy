// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

metadata suppressions = [
    {
        id: "HttpMethodSemantics"
        namespace: "tenantfrontdoor"
        reason: "UpdateTenantRouteStatus is a PUT that replaces one field (spec §5.1); it is idempotent."
    }
]

namespace tenantfrontdoor

use aws.apigateway#integration
use aws.apigateway#requestValidator
use aws.auth#sigv4
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The route registrar (spec §3.4, §5.1): the only writer of the route
/// table. Every operation is AWS_IAM (SigV4) and idempotent. The API's
/// resource policy admits only the control plane's global hook role and
/// the edge operator role; the registrar checks every write against the
/// control plane, never against the request (ADR-0013, ADR-0017).
@title("Tenant Front Door - Route Registrar")
@restJson1
@sigv4(name: "execute-api")
@integration(type: "aws_proxy", httpMethod: "POST", uri: "PLACEHOLDER")
@requestValidator("full")
service RegistrarService {
    version: "2026-11-19"
    resources: [
        CellRoute
        TenantRoute
        HostRoute
    ]
    errors: [
        ValidationException
        BadRequestError
        ForbiddenError
        ConflictError
        ServiceUnavailableError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/// A cell id as the control plane names it (an upper-case Crockford ULID),
/// or its lower-case form. The registrar lower-cases it for the route table
/// and upper-cases it to read the control plane (§4.1).
@pattern("^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$")
string CellId

/// A tenant id, in the control plane's upper-case form or lower-cased
/// (§4.1). Stored ids are one DNS label: `[a-z0-9-]{1,63}`, not starting or
/// ending with `-`.
@pattern("^[0-9A-Za-z](?:[0-9A-Za-z-]{0,61}[0-9A-Za-z])?$")
string TenantId

/// A full host name, lower case, at most 253 characters.
@length(min: 1, max: 253)
@pattern("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
string HostName

/// A tenant's dedicated domain: one host name of at most 64 characters, no
/// wildcard. The registrar also refuses `appDomain` and any name under it
/// (§5.1).
@length(min: 4, max: 64)
@pattern("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
string CustomDomain

/// A cell's API origin: a Lambda function URL host. The registrar also
/// checks that its Region is the control plane's (§5.1).
@pattern("^[a-z0-9]{32}\\.lambda-url\\.[a-z0-9-]+\\.on\\.aws$")
string ApiDomain

/// The deployment's `createdAt` as Unix milliseconds (§4.1).
@range(min: 0)
long DeploymentRevision

/// Error message. Never names another tenant, account or cell (§5.1).
string ErrorMessage

// ---------------------------------------------------------------------------
// Errors (§5.1)
// ---------------------------------------------------------------------------

/// 400: a malformed id, domain or API domain, or a request the
/// deployment's inputs do not allow (`customDomain` while
/// `dedicatedDomains` is off).
@error("client")
@httpError(400)
structure BadRequestError {
    @required
    message: ErrorMessage
}

/// 403: the placement record is missing or belongs to another
/// application, or a role other than the edge operator role sent an
/// operator-only field.
@error("client")
@httpError(403)
structure ForbiddenError {
    @required
    message: ErrorMessage
}

/// 409: the control-plane record is not in the status of the operation, a
/// write-once origin would change, a needed route is missing, or a domain
/// is held by another tenant.
@error("client")
@httpError(409)
structure ConflictError {
    @required
    message: ErrorMessage
}

/// 422: the dedicated domain's certificate failed validation or timed out.
@error("client")
@httpError(422)
structure UnprocessableError {
    @required
    message: ErrorMessage
}

/// 507: the write would exceed the route table's 5 MB, or ACM refused a
/// certificate request for its quota (§4.1).
@error("server")
@httpError(507)
structure InsufficientStorageError {
    @required
    message: ErrorMessage
}

/// 503: the control plane cannot be read or returned a `createdAt` that
/// does not parse, or the store's ETag still conflicts after five
/// attempts. The write is refused, never made unchecked; the caller
/// retries.
@error("server")
@httpError(503)
@retryable
structure ServiceUnavailableError {
    @required
    message: ErrorMessage
}

@error("server")
@httpError(500)
structure InternalServerError {
    @required
    message: ErrorMessage
}
