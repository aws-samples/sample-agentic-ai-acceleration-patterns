// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Application resource
// ---------------------------------------------------------------------------

/// An application the vendor deploys for tenants (ADR-032): a provisioning
/// source, the cell and tenant lifecycle scripts, and how many tenants share
/// one cell. Operators register applications at run time; every cell of an
/// application is stamped from the application's definition at creation and
/// keeps that stamp, so a replaced definition reaches only cells created
/// afterwards (P-4). The record carries the authoritative count of the
/// application's cells, claimed in the new-cell placement transaction and
/// released in the cell delete transaction. There is no status - application
/// operations are synchronous and run no build.
resource Application {
    identifiers: {
        applicationId: ApplicationId
    }
    put: PutApplication
    read: GetApplication
    delete: DeleteApplication
    list: ListApplications
}

// ---------------------------------------------------------------------------
// Application types
// ---------------------------------------------------------------------------

/// Operator-chosen application identifier. Lower-case letters, digits and
/// hyphens only, so it is usable as a parameter path segment
/// (/application-plane/applications/<applicationId>/shared/*).
@pattern("^[a-z0-9-]{1,32}$")
string ApplicationId

/// A list of application ids, each at most once; never empty — omit the
/// field to admit every application.
@length(min: 1)
@uniqueItems
list ApplicationIdList {
    member: ApplicationId
}

/// How a new cell of the application picks among eligible accounts with free
/// cell capacity (ADR-036). Dedicated accounts are always tried before shared
/// ones; the strategy orders the accounts inside each group.
enum PlacementStrategy {
    /// Oldest registered account first - one account fills before the next is touched.
    FILL
    /// The account with the fewest cells first - cells rotate over the open accounts.
    ROUND_ROBIN
}

/// Current number of the application's cells - the authoritative counter,
/// claimed and released only by the two transactional code paths.
@range(min: 0)
integer ApplicationCellCount

/// An application as returned by the API: its definition, placement
/// strategy, parameter declarations and cell count.
structure ApplicationSummary {
    /// The application id.
    @required
    applicationId: ApplicationId

    /// The build input source containing the provisioning scripts.
    @required
    source: SourceDefinition

    /// Lifecycle scripts for the shared cell deployment.
    @required
    cellScripts: ScriptLocations

    /// Lifecycle scripts for per-tenant deployments.
    @required
    tenantScripts: ScriptLocations

    /// Maximum number of tenants a cell of this application holds; applies
    /// to cells created after it was set.
    @required
    maxTenants: MaxTenants

    /// How new cells pick among eligible accounts.
    @required
    placementStrategy: PlacementStrategy

    /// The parameters the tenant scripts take (ADR-039); empty when none.
    @required
    parameters: ParameterDeclarationList

    /// The parameters the cell scripts take (ADR-040); empty when none.
    @required
    cellParameters: CellParameterDeclarationList

    /// Current number of this application's cells.
    @required
    cellCount: ApplicationCellCount

    /// When the application was registered.
    @required
    createdAt: IsoTimestamp

    /// When the application record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// A page of applications.
list ApplicationList {
    member: ApplicationSummary
}

// ---------------------------------------------------------------------------
// PutApplication - PUT /applications/{applicationId} -> 200
// ---------------------------------------------------------------------------

/// Registers an application or replaces its definition (create-or-replace).
/// The definition is validated as a whole: every script path present, a
/// non-empty source, maxTenants at least one (ValidationException otherwise).
/// A source not pinned to a full commit SHA is accepted and logged
/// (ADR-020). The parameter declarations are validated with it: names
/// unique within and across both lists, no default on a required
/// parameter, a default on every cell parameter, defaults of at most 1,024
/// bytes with no control characters (ValidationException otherwise). On an
/// existing application the definition and placement strategy are replaced
/// and cellCount is never touched; cells already created keep their stamp.
/// Each declaration list is replaced only when sent: an absent list keeps
/// the current one, an empty list clears it (ADR-039, ADR-040). A put that
/// keeps a list is conditioned on that list being unchanged since the
/// service read it; ConflictError when it changed in between (retry).
/// Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/applications/{applicationId}", code: 200)
operation PutApplication {
    input := {
        /// The application to register.
        @required
        @httpLabel
        applicationId: ApplicationId

        /// The build input source containing the provisioning scripts.
        @required
        source: SourceDefinition

        /// Lifecycle scripts for the shared cell deployment.
        @required
        cellScripts: ScriptLocations

        /// Lifecycle scripts for per-tenant deployments.
        @required
        tenantScripts: ScriptLocations

        /// Maximum number of tenants per cell for cells created from now on.
        @required
        maxTenants: MaxTenants

        /// How new cells pick among eligible accounts. Default FILL.
        placementStrategy: PlacementStrategy

        /// The parameters the tenant scripts take. Absent keeps the current
        /// list (none on a new application); an empty list clears it.
        parameters: ParameterDeclarationList

        /// The parameters the cell scripts take. Absent keeps the current
        /// list (none on a new application); an empty list clears it.
        cellParameters: CellParameterDeclarationList
    }

    output := {
        /// The registered application.
        @required
        application: ApplicationSummary
    }

    errors: [
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// GetApplication - GET /applications/{applicationId} -> 200
// ---------------------------------------------------------------------------

/// Returns a registered application: its definition, placement strategy,
/// both sets of parameter declarations and cell count.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/applications/{applicationId}", code: 200)
operation GetApplication {
    input := {
        /// The application to fetch.
        @required
        @httpLabel
        applicationId: ApplicationId
    }

    output := {
        /// The requested application.
        @required
        application: ApplicationSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// DeleteApplication - DELETE /applications/{applicationId} -> 200
// ---------------------------------------------------------------------------

/// Deregisters an empty application. A single conditional delete on
/// cellCount = 0 - the counterpart of the cell-slot claim; an application
/// that still has cells is rejected with ConflictError. Accounts that name
/// the application in applicationIds are not touched. Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/applications/{applicationId}", code: 200)
operation DeleteApplication {
    input := {
        /// The application to deregister.
        @required
        @httpLabel
        applicationId: ApplicationId
    }

    output := {
        /// The application as it was before deletion.
        @required
        application: ApplicationSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// ListApplications - GET /applications -> 200
// ---------------------------------------------------------------------------

/// Lists registered applications with pagination: id, maxTenants, placement
/// strategy and cellCount per application.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "applications")
@http(method: "GET", uri: "/applications", code: 200)
operation ListApplications {
    input := {
        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of applications to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of applications.
        @required
        applications: ApplicationList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}
