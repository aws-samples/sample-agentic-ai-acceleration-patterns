// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Deployment resource
// ---------------------------------------------------------------------------

/// One tenant in one application (ADR-037): the tenant's per-tenant
/// deployment inside a cell of that application. Identified by tenant and
/// application - a tenant has at most one deployment per application. The
/// deployment owns the placement (cellId, assigned at creation and never
/// changed), the lifecycle status and the build bookkeeping; it carries no
/// source and no scripts of its own - its effective definition is the cell's
/// stamped definition (P-4). CreateDeployment runs placement; update and
/// delete run the cell's tenant scripts.
resource Deployment {
    identifiers: {
        tenantId: TenantId
        applicationId: ApplicationId
    }
    read: GetDeployment
    update: UpdateDeployment
    delete: DeleteDeployment
    list: ListDeployments
    // Bound as an instance operation, not the `create` lifecycle slot: the
    // request names both identifiers (tenantId in the path, applicationId in
    // the body), and Smithy requires a `create` operation NOT to bind every
    // identifier (ResourceIdentifierBinding). It is still the create.
    operations: [
        CreateDeployment
    ]
}

// ---------------------------------------------------------------------------
// Deployment summary shapes
// ---------------------------------------------------------------------------

/// A deployment as returned by the API: its identity, placement, lifecycle
/// status and build bookkeeping. The effective definition is available via
/// GetDeployment.
@references([{resource: Tenant}, {resource: Application}, {resource: Cell}])
structure DeploymentSummary {
    /// The tenant the deployment belongs to.
    @required
    tenantId: TenantId

    /// The application the deployment is of.
    @required
    applicationId: ApplicationId

    /// The cell this deployment is placed in - a cell of the application;
    /// assigned at creation, never changes.
    @required
    cellId: CellId

    /// Current lifecycle status of the deployment.
    @required
    status: LifecycleStatus

    /// Failure detail, populated when status is a *_FAILED value.
    statusReason: String

    /// ARN of the most recent successful tenant-scoped CodeBuild build.
    lastBuildId: String

    /// When the deployment was created.
    @required
    createdAt: IsoTimestamp

    /// When the deployment record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// A page of deployments.
list DeploymentList {
    member: DeploymentSummary
}

// ---------------------------------------------------------------------------
// CreateDeployment - POST /tenants/{tenantId}/deployments -> 202
// ---------------------------------------------------------------------------

/// Deploys an application for a tenant. Atomically claims a slot in an
/// ACTIVE cell of the application with free capacity - or creates a new cell
/// when none has capacity (ADR-013), claiming a cell slot on its account
/// (ADR-024) and counting it on the application (ADR-032) - counts the
/// deployment on the tenant, persists the deployment in CREATING status with
/// its cellId, and starts the provisioning workflow (the tenant create
/// build, preceded by the cell create build if a new cell was needed).
/// Without accountId, placement considers vendor-owned accounts that admit
/// the application; with accountId, only that registered account (the only
/// way into a tenant-owned account), which must admit the application
/// (ValidationException otherwise). Carries no resource definition - the
/// cell's stamped definition applies (P-4). Asynchronous: returns 202
/// immediately; poll GetDeployment for the terminal status (ACTIVE or
/// CREATE_FAILED). ResourceNotFoundError for an unknown tenant, application
/// or accountId; ConflictError when the tenant already has a deployment of
/// the application; InsufficientCapacityError when no eligible account has
/// cell capacity.
@authorizer("vendor-authorizer")
@http(method: "POST", uri: "/tenants/{tenantId}/deployments", code: 202)
operation CreateDeployment {
    input := @references([{resource: Tenant}, {resource: Application}, {resource: Account}]) {
        /// The tenant to deploy for.
        @required
        @httpLabel
        tenantId: TenantId

        /// The registered application to deploy.
        @required
        applicationId: ApplicationId

        /// Email of the deployment's first customer administrator. Passed to
        /// the tenant create script as ADMIN_EMAIL for application-plane
        /// user bootstrap; never persisted.
        @required
        adminEmail: EmailAddress

        /// Pin the deployment to one registered account. Required to place
        /// into a tenant-owned account; optional for a vendor-owned one.
        /// Absent, placement chooses among vendor-owned accounts that admit
        /// the application.
        accountId: AccountId

        /// Optional idempotency token. Retrying CreateDeployment with the
        /// same token returns the previously created deployment instead of
        /// failing on the existing one - the guard against a client retry
        /// after an API timeout. Reusing a token with different parameters
        /// is rejected with ConflictError.
        @idempotencyToken
        clientToken: IdempotencyToken
    }

    output := {
        /// The created deployment, in CREATING status, including its cellId
        /// placement.
        @required
        deployment: DeploymentSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
        InsufficientCapacityError
    ]
}

// ---------------------------------------------------------------------------
// GetDeployment - GET /tenants/{tenantId}/deployments/{applicationId} -> 200
// ---------------------------------------------------------------------------

/// Returns a deployment. This is the polling endpoint for asynchronous
/// lifecycle operations: status, statusReason, lastBuildId and cellId reflect
/// placement and provisioning progress. Also returns the deployment's
/// effective definition - source and scripts resolved from the cell's
/// stamped definition - and the account the cell lives in.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/tenants/{tenantId}/deployments/{applicationId}", code: 200)
operation GetDeployment {
    input := {
        /// The tenant.
        @required
        @httpLabel
        tenantId: TenantId

        /// The application.
        @required
        @httpLabel
        applicationId: ApplicationId
    }

    output := @references([{resource: Account}]) {
        /// The requested deployment.
        @required
        deployment: DeploymentSummary

        /// The build input source, resolved from the cell's stamped
        /// definition.
        @required
        source: SourceDefinition

        /// The per-tenant deployment lifecycle scripts, resolved from the
        /// cell's stamped definition (the cell's tenantScripts).
        @required
        scripts: ScriptLocations

        /// The account the cell - and so this deployment - lives in.
        @required
        accountId: AccountId
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// UpdateDeployment - PUT /tenants/{tenantId}/deployments/{applicationId} -> 202
// ---------------------------------------------------------------------------

/// Re-applies the deployment: no body - sets UPDATING status and starts the
/// provisioning workflow, which runs the cell's stamped tenant update script
/// in AWS CodeBuild. Asynchronous: returns 202 immediately; poll
/// GetDeployment for the terminal status. Allowed when the deployment is
/// ACTIVE or UPDATE_FAILED and the cell is ACTIVE; rejected with
/// ConflictError otherwise - from CREATE_FAILED the remediation is delete +
/// recreate, and no tenant build runs against a shared deployment that is
/// mid-change.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}/deployments/{applicationId}", code: 202)
operation UpdateDeployment {
    input := {
        /// The tenant.
        @required
        @httpLabel
        tenantId: TenantId

        /// The application.
        @required
        @httpLabel
        applicationId: ApplicationId
    }

    output := {
        /// The deployment, now in UPDATING status.
        @required
        deployment: DeploymentSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// DeleteDeployment - DELETE /tenants/{tenantId}/deployments/{applicationId} -> 202
// ---------------------------------------------------------------------------

/// Deprovisions a deployment. Sets DELETING status and starts the
/// provisioning workflow, which runs the cell's stamped tenant delete script
/// in AWS CodeBuild, then transactionally removes the deployment record,
/// frees its slot in the cell and releases its count on the tenant.
/// Asynchronous: returns 202 immediately; poll GetDeployment until it returns
/// 404 (deleted) or DELETE_FAILED. Rejected with ConflictError while the
/// deployment is in-flight (CREATING/UPDATING/DELETING); allowed from ACTIVE
/// and all *_FAILED statuses regardless of cell status - the delete script is
/// the cleanup path, including when the cell itself is CREATE_FAILED.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/tenants/{tenantId}/deployments/{applicationId}", code: 202)
operation DeleteDeployment {
    input := {
        /// The tenant.
        @required
        @httpLabel
        tenantId: TenantId

        /// The application.
        @required
        @httpLabel
        applicationId: ApplicationId
    }

    output := {
        /// The deployment, now in DELETING status.
        @required
        deployment: DeploymentSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// ListDeployments - GET /deployments[?tenantId=|?cellId=|?applicationId=] -> 200
// ---------------------------------------------------------------------------

/// Lists deployments with pagination, optionally filtered to one tenant,
/// one cell or one application - at most one filter per request
/// (ValidationException for two). A filter is a query predicate, not a
/// resource lookup - an unknown id yields an empty page, not a 404.
/// Statuses are always current - terminal state is written by the
/// provisioning workflow, not repaired by readers.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "deployments")
@http(method: "GET", uri: "/deployments", code: 200)
operation ListDeployments {
    input := @references([{resource: Tenant}, {resource: Cell}, {resource: Application}]) {
        /// Only return this tenant's deployments.
        @httpQuery("tenantId")
        tenantId: TenantId

        /// Only return deployments placed in this cell.
        @httpQuery("cellId")
        cellId: CellId

        /// Only return deployments of this application.
        @httpQuery("applicationId")
        applicationId: ApplicationId

        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of deployments to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of deployments.
        @required
        deployments: DeploymentList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}
