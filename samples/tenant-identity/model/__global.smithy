// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

// Operation names use the AWS lifecycle verbs, plus the three non-lifecycle
// verbs this sample needs (spec R-15, docs/sample-standard.md §4.2). DANGER
// makes a bad name fail `smithy build`.
metadata validators = [
    {
        name: "StandardOperationVerb"
        severity: "DANGER"
        configuration: {
            verbs: ["Create", "Get", "Update", "Delete", "List", "Issue", "Refresh", "Exchange"]
            suggestAlternatives: {
                Read: ["Get"]
                Fetch: ["Get"]
                Describe: ["Get"]
                Add: ["Create"]
                Remove: ["Delete"]
            }
        }
    }
]

// The three services name the same user with the same Username shape on
// purpose: one Cognito user, two doors (spec P-11). The resources are in
// different services, so a cross-service @references would be wrong.
metadata suppressions = [
    {
        id: "MemberShouldReferenceResource"
        namespace: "tenantidentity"
        reason: "The platform and tenant services each own a user resource keyed by Username (spec P-11)."
    }
]

namespace tenantidentity

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/// Tenant identifier (ULID), generated at onboarding.
@pattern("^[0-9A-HJKMNP-TV-Z]{26}$")
string TenantId

/// Human-readable tenant name. Not unique.
@length(min: 1, max: 128)
string TenantName

/// E-mail address. In every pool the sample creates, e-mail is the
/// sign-in name.
@pattern("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
@length(min: 3, max: 254)
string EmailAddress

/// The Cognito username of a user. Pools sign in with e-mail, so Cognito
/// assigns the username (the user's `sub`). The admin APIs also accept the
/// e-mail address here.
@length(min: 1, max: 128)
@pattern("^[A-Za-z0-9._@+-]+$")
string Username

/// ISO 8601 timestamp.
@timestampFormat("date-time")
timestamp IsoTimestamp

/// Opaque pagination token.
@length(min: 1, max: 4096)
string PaginationToken

/// A password. Never logged.
@sensitive
@length(min: 8, max: 256)
string Password

/// A Cognito-issued JWT or refresh token. Never logged.
@sensitive
@length(min: 1, max: 16384)
string TokenValue

/// The deploy-time topology (spec P-7).
enum Topology {
    POOL_PER_TENANT = "pool-per-tenant"
    SHARED_POOL = "shared-pool"
    SHARED_POOL_MULTI_TENANT = "shared-pool-multi-tenant"
}

/// Tenant status in the registry (spec §4.1).
enum TenantStatus {
    /// Tokens may name the tenant.
    ACTIVE

    /// Offboarding has started; no new token names the tenant (spec P-2).
    DELETING
}

/// A tenant as the registry holds it (spec §4.1).
structure Tenant {
    @required
    tenantId: TenantId

    @required
    name: TenantName

    @required
    status: TenantStatus

    @required
    topology: Topology

    /// pool-per-tenant only: the tenant's own user pool.
    userPoolId: String

    /// pool-per-tenant only: the tenant's own app client.
    appClientId: String

    /// pool-per-tenant only: the issuer URL of the tenant's pool. The
    /// registry is the issuer allowlist a consumer of this topology needs.
    issuer: String

    /// shared-pool-multi-tenant only: the membership group, `t-<tenantId>`.
    groupName: String

    @required
    createdAt: IsoTimestamp

    @required
    updatedAt: IsoTimestamp
}

list TenantList {
    member: Tenant
}

/// A user as seen through one tenant. Never says which other tenants the
/// user belongs to (spec §5.1).
structure User {
    @required
    username: Username

    @required
    email: EmailAddress

    /// Membership of the tenant's `admin-<tenantId>` group (ADR-0015).
    @required
    admin: Boolean

    /// Cognito's user status, for example FORCE_CHANGE_PASSWORD or CONFIRMED.
    @required
    status: String

    @required
    createdAt: IsoTimestamp
}

list UserList {
    member: User
}

/// A user just added to a tenant.
structure NewUser {
    @required
    user: User

    /// Present only when a new Cognito user was created. Returned once and
    /// never logged.
    temporaryPassword: Password
}

// ---------------------------------------------------------------------------
// Errors shared by the platform and tenant services (spec §5.3)
// ---------------------------------------------------------------------------

/// Why a request was refused as invalid.
enum ValidationReason {
    /// The operation has no meaning in the deployed topology (spec P-4).
    UNSUPPORTED_IN_TOPOLOGY = "UnsupportedInTopology"

    /// Any other invalid input.
    INVALID_INPUT = "InvalidInput"
}

/// Malformed input, or an operation the deployed topology does not support.
@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String

    @required
    reason: ValidationReason
}

/// Unknown tenant or user, or a user who does not belong to the tenant
/// named by the request (spec R-12).
@error("client")
@httpError(404)
structure ResourceNotFoundError {
    @required
    message: String
}

/// The request conflicts with current state (spec §5.3).
@error("client")
@httpError(409)
structure ConflictError {
    @required
    message: String
}

/// An unexpected server-side failure.
@error("server")
@httpError(500)
structure InternalServerError {
    @required
    message: String
}
