// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantidentity

use aws.apigateway#authorizer
use aws.apigateway#authorizers
use aws.apigateway#integration
use aws.apigateway#requestValidator
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The tenant admin's door (spec §5.2, ADR-0014). The tenant comes from the
/// verified, narrowed access token, never from the request (spec P-11). The
/// tenant authoriser verifies the token on every call, with no cache
/// (ADR-0007).
@title("Tenant Identity - Tenant API")
@restJson1
@httpApiKeyAuth(name: "Authorization", in: "header")
@authorizers(
    "tenant-authorizer": {
        scheme: "smithy.api#httpApiKeyAuth"
        type: "token"
        uri: "PLACEHOLDER"
        identitySource: "method.request.header.Authorization"
        // Caching off: the authoriser re-reads the tenant's status on every
        // request, so offboarding stops this route at once (spec P-2, N-7).
        resultTtlInSeconds: 0
    }
)
@authorizer("tenant-authorizer")
@integration(type: "aws_proxy", httpMethod: "POST", uri: "PLACEHOLDER")
@requestValidator("full")
service TenantService {
    version: "2026-10-21"
    resources: [
        TenantUser
    ]
    errors: [
        ValidationException
        ValidationError
        InternalServerError
    ]
}

/// A user of the caller's own tenant.
resource TenantUser {
    identifiers: {
        username: Username
    }
    create: CreateTenantUser
    read: GetTenantUser
    update: UpdateTenantUser
    delete: DeleteTenantUser
    list: ListTenantUsers
}

/// Twin of platform CreateUser, for the caller's tenant.
@http(method: "POST", uri: "/tenant/users", code: 201)
operation CreateTenantUser {
    input := {
        @required
        email: EmailAddress

        admin: Boolean
    }

    output := {
        @required
        user: User

        temporaryPassword: Password
    }

    errors: [
        ConflictError
    ]
}

@readonly
@http(method: "GET", uri: "/tenant/users/{username}")
operation GetTenantUser {
    input := {
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
@http(method: "GET", uri: "/tenant/users")
operation ListTenantUsers {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken
    }

    output := {
        @required
        users: UserList

        nextToken: PaginationToken
    }
}

/// Changes the admin flag. A caller cannot demote themselves (spec R-13).
@http(method: "PATCH", uri: "/tenant/users/{username}")
operation UpdateTenantUser {
    input := {
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

/// Removes the user from the caller's tenant. A caller cannot delete
/// themselves (spec R-13).
@idempotent
@http(method: "DELETE", uri: "/tenant/users/{username}", code: 204)
operation DeleteTenantUser {
    input := {
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
