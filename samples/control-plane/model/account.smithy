// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Account resource
// ---------------------------------------------------------------------------

/// An AWS account the control plane may provision cells into (ADR-024).
/// Operators register accounts at run time: a vendor-owned account joins the
/// fleet and is filled by placement; a tenant-owned account belongs to a
/// customer and receives only deployments whose CreateDeployment names it.
/// An account admits every application (shared) or only the applications
/// named in applicationIds (dedicated) (ADR-033). Each account installs the
/// provisioning role pair (ADR-025) before it can be registered - PutAccount
/// verifies that handshake (ADR-027). The account record carries the
/// authoritative cell counter: the new-cell placement transaction claims a
/// slot (cellCount < maxCells) and the cell delete transaction releases it.
/// There is no status - account operations are synchronous and run no build.
resource Account {
    identifiers: {
        accountId: AccountId
    }
    put: PutAccount
    read: GetAccount
    delete: DeleteAccount
    list: ListAccounts
}

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

/// A twelve-digit AWS account id.
@pattern("^[0-9]{12}$")
string AccountId

/// Who owns a registered account, which decides whether untargeted placement
/// may choose it. Immutable after registration.
enum AccountOwner {
    /// The vendor's own account: part of the fleet, filled by placement.
    VENDOR
    /// A customer's account: receives only deployments that name it explicitly.
    TENANT
}

/// Maximum number of cells an account may hold. Replaceable; lowering it
/// below the current cellCount only stops new cells there.
@range(min: 1)
integer MaxCells

/// Current number of cells in an account - the authoritative cell counter,
/// claimed and released only by the two transactional code paths (ADR-024).
@range(min: 0)
integer CellCount

/// The external id the account's provisioning roles require on AssumeRole
/// (the confused-deputy guard, ADR-025). Supplied by the account owner when
/// they install the role pair and by the operator at registration; never
/// returned by the API.
@length(min: 2, max: 1224)
@pattern("^[\\w+=,.@:/-]+$")
string ExternalId

/// An account as returned by the API: owner, admitted applications,
/// capacity/occupancy, and whether an external id is configured (never its
/// value).
structure AccountSummary {
    /// The AWS account id.
    @required
    accountId: AccountId

    /// Who owns the account.
    @required
    owner: AccountOwner

    /// The applications this account admits. Absent: the account is shared
    /// and admits every application (ADR-033).
    applicationIds: ApplicationIdList

    /// Maximum number of cells this account may hold.
    @required
    maxCells: MaxCells

    /// Current number of cells in this account.
    @required
    cellCount: CellCount

    /// Whether AssumeRole into this account presents an external id.
    @required
    externalIdConfigured: Boolean

    /// When the account was registered.
    @required
    createdAt: IsoTimestamp

    /// When the account record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// A page of accounts.
list AccountList {
    member: AccountSummary
}

// ---------------------------------------------------------------------------
// PutAccount - PUT /accounts/{accountId} -> 200
// ---------------------------------------------------------------------------

/// Registers an account or replaces its policy fields (create-or-replace).
/// Every applicationIds entry must name a registered application
/// (ResourceNotFoundError otherwise). Before writing, the control plane
/// verifies the handshake by assuming both provisioning roles of the account
/// with the given external id (ADR-027); a role that cannot be assumed is a
/// ValidationException naming it. On an existing account the owner must
/// match (ConflictError otherwise); maxCells, applicationIds and externalId
/// are replaced (an absent applicationIds makes the account shared);
/// cellCount is never touched. Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/accounts/{accountId}", code: 200)
operation PutAccount {
    input := {
        /// The AWS account to register.
        @required
        @httpLabel
        accountId: AccountId

        /// Who owns the account. Immutable after the first registration.
        @required
        owner: AccountOwner

        /// Maximum number of cells the account may hold.
        @required
        maxCells: MaxCells

        /// The applications this account admits (dedicated). Absent: the
        /// account is shared and admits every application.
        applicationIds: ApplicationIdList

        /// External id configured on the account's provisioning roles.
        /// Required when owner is TENANT (ValidationException without it);
        /// optional for VENDOR, omitted when the roles were installed
        /// without one.
        externalId: ExternalId
    }

    output := {
        /// The registered account.
        @required
        account: AccountSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// GetAccount - GET /accounts/{accountId} -> 200
// ---------------------------------------------------------------------------

/// Returns a registered account: owner, admitted applications,
/// cellCount/maxCells, and whether an external id is configured.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/accounts/{accountId}", code: 200)
operation GetAccount {
    input := {
        /// The account to fetch.
        @required
        @httpLabel
        accountId: AccountId
    }

    output := {
        /// The requested account.
        @required
        account: AccountSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// DeleteAccount - DELETE /accounts/{accountId} -> 200
// ---------------------------------------------------------------------------

/// Deregisters an empty account. A single conditional delete on
/// cellCount = 0 - the counterpart of the cell-slot claim; an occupied
/// account is rejected with ConflictError. The account's provisioning roles
/// stay installed: removing them is the owner's act. Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/accounts/{accountId}", code: 200)
operation DeleteAccount {
    input := {
        /// The account to deregister.
        @required
        @httpLabel
        accountId: AccountId
    }

    output := {
        /// The account as it was before deletion.
        @required
        account: AccountSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// ListAccounts - GET /accounts -> 200
// ---------------------------------------------------------------------------

/// Lists registered accounts with pagination - the operator's capacity view
/// one level above ListCells: owner, admitted applications and
/// cellCount/maxCells per account.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "accounts")
@http(method: "GET", uri: "/accounts", code: 200)
operation ListAccounts {
    input := {
        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of accounts to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of accounts.
        @required
        accounts: AccountList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}
