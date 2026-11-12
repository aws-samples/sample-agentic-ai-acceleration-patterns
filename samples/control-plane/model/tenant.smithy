// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Tenant resource
// ---------------------------------------------------------------------------

/// A tenant - a customer of the vendor. A tenant can use any number of the
/// vendor's applications; each use is a deployment (ADR-037), the tenant's
/// per-tenant deployment inside a cell of that application. The tenant
/// record holds metadata and the authoritative count of its deployments,
/// claimed in the placement transaction and released in the deployment
/// delete transaction. There is no status - tenant operations are
/// synchronous and run no build; everything provisioned for a tenant is a
/// deployment.
resource Tenant {
    identifiers: {
        tenantId: TenantId
    }
    create: CreateTenant
    read: GetTenant
    update: UpdateTenant
    delete: DeleteTenant
    list: ListTenants
}

// ---------------------------------------------------------------------------
// Tenant summary shapes
// ---------------------------------------------------------------------------

/// Current number of a tenant's deployments - the authoritative counter,
/// claimed and released only by the two transactional code paths.
@range(min: 0)
integer DeploymentCount

/// A tenant as returned by the API: metadata and deployment count.
structure TenantSummary {
    /// Unique tenant identifier.
    @required
    tenantId: TenantId

    /// Human-readable tenant name.
    @required
    name: TenantName

    /// Free-text tenant description.
    description: TenantDescription

    /// Current number of this tenant's deployments.
    @required
    deploymentCount: DeploymentCount

    /// When the tenant was created.
    @required
    createdAt: IsoTimestamp

    /// When the tenant record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// A page of tenants.
list TenantList {
    member: TenantSummary
}

// ---------------------------------------------------------------------------
// CreateTenant - POST /tenants -> 200
// ---------------------------------------------------------------------------

/// Creates a tenant record with no deployments. Nothing is provisioned -
/// deploy an application for the tenant with CreateDeployment. Synchronous.
@authorizer("vendor-authorizer")
@http(method: "POST", uri: "/tenants", code: 200)
operation CreateTenant {
    input := {
        /// Human-readable tenant name.
        @required
        name: TenantName

        /// Free-text tenant description.
        description: TenantDescription
    }

    output := {
        /// The created tenant.
        @required
        tenant: TenantSummary
    }
}

// ---------------------------------------------------------------------------
// GetTenant - GET /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Returns a tenant: metadata and deployment count. A tenant's deployments
/// are listed with ListDeployments?tenantId=.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/tenants/{tenantId}", code: 200)
operation GetTenant {
    input := {
        /// The tenant to fetch.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The requested tenant.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// UpdateTenant - PUT /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Updates tenant metadata (name, description). Synchronous; never touches
/// deploymentCount or any deployment.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}", code: 200)
operation UpdateTenant {
    input := {
        /// The tenant to update.
        @required
        @httpLabel
        tenantId: TenantId

        /// New tenant name.
        name: TenantName

        /// New tenant description.
        description: TenantDescription
    }

    output := {
        /// The updated tenant.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// DeleteTenant - DELETE /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Deletes an empty tenant. A single conditional delete on
/// deploymentCount = 0 - the counterpart of the deployment claim; a tenant
/// that still has deployments is rejected with ConflictError (delete them
/// first with DeleteDeployment). Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/tenants/{tenantId}", code: 200)
operation DeleteTenant {
    input := {
        /// The tenant to delete.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The tenant as it was before deletion.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// ListTenants - GET /tenants -> 200
// ---------------------------------------------------------------------------

/// Lists tenants with pagination. Tenants of one cell or one application are
/// listed through ListDeployments.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "tenants")
@http(method: "GET", uri: "/tenants", code: 200)
operation ListTenants {
    input := {
        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of tenants to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of tenants.
        @required
        tenants: TenantList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}
