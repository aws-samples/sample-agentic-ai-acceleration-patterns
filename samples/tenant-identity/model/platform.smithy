// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantidentity

use aws.apigateway#integration
use aws.apigateway#requestValidator
use aws.auth#sigv4
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The vendor's door (spec §5.1). Every route is under `/platform` and is
/// authorised by IAM (SigV4, ADR-0005). The tenant is named in the path.
@title("Tenant Identity - Platform API")
@restJson1
@sigv4(name: "execute-api")
@integration(type: "aws_proxy", httpMethod: "POST", uri: "PLACEHOLDER")
@requestValidator("full")
service PlatformService {
    version: "2026-10-21"
    resources: [
        PlatformTenant
    ]
    errors: [
        ValidationException
        ValidationError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/// A tenant in the registry and the Cognito identity it owns.
resource PlatformTenant {
    identifiers: {
        tenantId: TenantId
    }
    create: CreateTenant
    read: GetTenant
    delete: DeleteTenant
    list: ListTenants
    resources: [
        PlatformUser
    ]
}

/// Onboards a tenant and its first admin (ADR-0014). Synchronous (ADR-0004).
@http(method: "POST", uri: "/platform/tenants", code: 201)
operation CreateTenant {
    input := {
        @required
        name: TenantName

        /// The tenant's first admin.
        @required
        adminEmail: EmailAddress

        /// Required in a `tiered` deployment, refused (UnsupportedInTopology)
        /// in any other (ADR-0027). Chosen once; never inferred or defaulted.
        tier: Tier
    }

    output := {
        @required
        tenant: Tenant

        @required
        admin: NewUser
    }

    errors: [
        ConflictError
    ]
}

@readonly
@http(method: "GET", uri: "/platform/tenants/{tenantId}")
operation GetTenant {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        @required
        tenant: Tenant
    }

    errors: [
        ResourceNotFoundError
    ]
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "tenants")
@http(method: "GET", uri: "/platform/tenants")
operation ListTenants {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken
    }

    output := {
        @required
        tenants: TenantList

        nextToken: PaginationToken
    }
}

/// Offboards a tenant: status DELETING first, then the Cognito clean-up
/// (spec R-11). Idempotent: re-run it against a DELETING tenant.
@idempotent
@http(method: "DELETE", uri: "/platform/tenants/{tenantId}", code: 204)
operation DeleteTenant {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {}

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// User (within a tenant)
// ---------------------------------------------------------------------------

/// A user as seen through one tenant.
resource PlatformUser {
    identifiers: {
        tenantId: TenantId
        username: Username
    }
    create: CreateUser
    read: GetUser
    update: UpdateUser
    delete: DeleteUser
    list: ListUsers
    operations: [
        IssueToken
        RefreshToken
    ]
    resources: [
        PlatformMembership
    ]
}

@http(method: "POST", uri: "/platform/tenants/{tenantId}/users", code: 201)
operation CreateUser {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        email: EmailAddress

        /// Also add the user to `admin-<tenantId>`.
        admin: Boolean
    }

    output := {
        @required
        user: User

        temporaryPassword: Password
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

@readonly
@http(method: "GET", uri: "/platform/tenants/{tenantId}/users/{username}")
operation GetUser {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username
    }

    output := {
        @required
        user: User
    }

    errors: [
        ResourceNotFoundError
    ]
}

@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "users")
@http(method: "GET", uri: "/platform/tenants/{tenantId}/users")
operation ListUsers {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @httpQuery("nextToken")
        nextToken: PaginationToken
    }

    output := {
        @required
        users: UserList

        nextToken: PaginationToken
    }

    errors: [
        ResourceNotFoundError
    ]
}

/// Changes the admin flag: membership of `admin-<tenantId>`.
@http(method: "PATCH", uri: "/platform/tenants/{tenantId}/users/{username}")
operation UpdateUser {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username

        @required
        admin: Boolean
    }

    output := {
        @required
        user: User
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

@idempotent
@http(method: "DELETE", uri: "/platform/tenants/{tenantId}/users/{username}", code: 204)
operation DeleteUser {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username
    }

    output := {}

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

/// TEST AID - remove before production (ADR-0006). Sets a permanent
/// password and signs the user in with ADMIN_USER_PASSWORD_AUTH.
@http(method: "POST", uri: "/platform/tenants/{tenantId}/users/{username}/token", code: 200)
operation IssueToken {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username

        @required
        password: Password
    }

    output := {
        @required
        accessToken: TokenValue

        @required
        idToken: TokenValue

        @required
        refreshToken: TokenValue

        @required
        expiresIn: Integer
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

/// TEST AID - remove before production (ADR-0006). Refreshes with
/// REFRESH_TOKEN_AUTH so the test can show refresh re-runs the trigger.
@http(method: "POST", uri: "/platform/tenants/{tenantId}/users/{username}/token/refresh", code: 200)
operation RefreshToken {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username

        @required
        refreshToken: TokenValue
    }

    output := {
        @required
        accessToken: TokenValue

        @required
        idToken: TokenValue

        @required
        expiresIn: Integer
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// Membership (shared-pool-multi-tenant only)
// ---------------------------------------------------------------------------

/// Membership of a user in a tenant. Exists only in
/// shared-pool-multi-tenant; the other topologies answer
/// UnsupportedInTopology (spec P-4).
resource PlatformMembership {
    identifiers: {
        tenantId: TenantId
        username: Username
    }
    put: CreateMembership
    delete: DeleteMembership
}

/// Adds the user to `t-<tenantId>`. Idempotent.
@idempotent
@http(method: "PUT", uri: "/platform/tenants/{tenantId}/users/{username}/membership", code: 204)
operation CreateMembership {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username
    }

    output := {}

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

/// Removes the user from `t-<tenantId>` and `admin-<tenantId>`. Refused
/// with 409 when it is the user's last tenant (use DeleteUser).
@idempotent
@http(method: "DELETE", uri: "/platform/tenants/{tenantId}/users/{username}/membership", code: 204)
operation DeleteMembership {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        @httpLabel
        username: Username
    }

    output := {}

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}
