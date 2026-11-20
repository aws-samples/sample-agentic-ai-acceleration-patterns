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
/// delete transaction. Tenant operations run no build, but the three
/// mutations are asynchronous (202 + status + polling) so that global hooks
/// on tenant events can gate them (ADR-045); everything provisioned for a
/// tenant is a deployment.
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

    /// Lifecycle status (ADR-045). The record is live (its values in force)
    /// when ACTIVE, UPDATING or UPDATE_FAILED. A record stored before records
    /// of this type had a status reads as ACTIVE.
    @required
    status: LifecycleStatus

    /// Failure detail, populated when status is a *_FAILED value.
    statusReason: String

    /// The global hooks that ran in the record's last tenant event, in run
    /// order; empty when none ran.
    @required
    lastGlobalHooks: LastGlobalHookList

    /// The name of the workflow execution the record's last accepted
    /// operation started; hook builds receive it as EXECUTION_ID. Absent on
    /// a record stored before ADR-045.
    operationId: OperationId

    /// The name and description an UpdateTenant staged, present only while
    /// the tenant is UPDATING. The live name and description change when the
    /// workflow commits them after the TENANT_UPDATE pre hooks.
    pending: TenantPending

    /// When the tenant was created.
    @required
    createdAt: IsoTimestamp

    /// When the tenant record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// The values an UpdateTenant staged (ADR-045): the name and description the
/// commit makes live. An absent description is removed by the commit.
structure TenantPending {
    /// The staged tenant name.
    @required
    name: TenantName

    /// The staged tenant description.
    description: TenantDescription
}

/// A page of tenants.
list TenantList {
    member: TenantSummary
}

// ---------------------------------------------------------------------------
// CreateTenant - POST /tenants -> 202
// ---------------------------------------------------------------------------

/// Creates a tenant record with no deployments, CREATING, and starts the
/// TENANT_CREATE workflow (global hooks only). Nothing is provisioned -
/// deploy an application for the tenant with CreateDeployment once
/// GetTenant reports ACTIVE. A CREATE_FAILED tenant is deleted with
/// DeleteTenant. Asynchronous (ADR-045).
@authorizer("vendor-authorizer")
@http(method: "POST", uri: "/tenants", code: 202)
operation CreateTenant {
    input := {
        /// Human-readable tenant name.
        @required
        name: TenantName

        /// Free-text tenant description.
        description: TenantDescription
    }

    output := {
        /// The created tenant, CREATING.
        @required
        tenant: TenantSummary
    }
}

// ---------------------------------------------------------------------------
// GetTenant - GET /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Returns a tenant: metadata, deployment count, status and any staged
/// update - the polling endpoint of the tenant operations. A tenant's
/// deployments are listed with ListDeployments?tenantId=.
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
// UpdateTenant - PUT /tenants/{tenantId} -> 202
// ---------------------------------------------------------------------------

/// Updates tenant metadata (name, description): stages the values in
/// pending, moves the tenant to UPDATING and starts the TENANT_UPDATE
/// workflow, which commits them after the pre hooks. Never touches
/// deploymentCount or any deployment. ConflictError when the tenant is in
/// flight, CREATE_FAILED, DELETING or DELETE_FAILED. Asynchronous (ADR-045).
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}", code: 202)
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
        /// The tenant, UPDATING, with the staged values in pending.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// DeleteTenant - DELETE /tenants/{tenantId} -> 202
// ---------------------------------------------------------------------------

/// Deletes an empty tenant. One conditional write on deploymentCount = 0
/// moves it to DELETING - the counterpart of the deployment claim; a tenant
/// that still has deployments is rejected with ConflictError (delete them
/// first with DeleteDeployment). The TENANT_DELETE workflow then deletes the
/// record; no hook can stop it. Asynchronous (ADR-045).
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/tenants/{tenantId}", code: 202)
operation DeleteTenant {
    input := {
        /// The tenant to delete.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The tenant, DELETING.
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
