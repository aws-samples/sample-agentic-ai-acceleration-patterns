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
/// Account operations run no build, but PutAccount and DeleteAccount are
/// asynchronous (202 + status + polling) so that global hooks on account
/// events can gate them (ADR-045).
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

    /// Lifecycle status (ADR-045). The record is live (its values in force)
    /// when ACTIVE, UPDATING or UPDATE_FAILED. A record stored before records
    /// of this type had a status reads as ACTIVE.
    @required
    status: LifecycleStatus

    /// Failure detail, populated when status is a *_FAILED value.
    statusReason: String

    /// The global hooks that ran in the record's last account event, in run
    /// order; empty when none ran.
    @required
    lastGlobalHooks: LastGlobalHookList

    /// The name of the workflow execution the record's last accepted
    /// operation started; hook builds receive it as EXECUTION_ID. Absent on
    /// a record stored before ADR-045.
    operationId: OperationId

    /// The maxCells and applicationIds a replacing PutAccount staged,
    /// present only while the account is UPDATING. Placement uses the live
    /// values until the workflow commits them. Never holds the external id,
    /// which a replace writes into the record at once.
    pending: AccountPending

    /// When the account was registered.
    @required
    createdAt: IsoTimestamp

    /// When the account record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// The values a replacing PutAccount staged (ADR-045): the maxCells and
/// applicationIds the commit makes live. An absent applicationIds makes the
/// account shared once committed. The external id is never staged.
structure AccountPending {
    /// The staged cell capacity.
    @required
    maxCells: MaxCells

    /// The staged admitted applications. Absent: shared once committed.
    applicationIds: ApplicationIdList
}

/// A page of accounts.
list AccountList {
    member: AccountSummary
}

// ---------------------------------------------------------------------------
// PutAccount - PUT /accounts/{accountId} -> 202
// ---------------------------------------------------------------------------

/// Registers an account or replaces its policy fields (create-or-replace).
/// Every applicationIds entry must name a registered application
/// (ResourceNotFoundError otherwise). Before writing, the control plane
/// verifies the handshake by assuming both provisioning roles of the account
/// with the given external id (ADR-027); a role that cannot be assumed is a
/// ValidationException naming it. On an existing account the owner must
/// match (ConflictError otherwise); cellCount is never touched. A new
/// account is inserted CREATING and runs ACCOUNT_CREATE. On a live account
/// the external id is written at once and maxCells and applicationIds are
/// staged in pending (an absent applicationIds makes the account shared once
/// committed) while ACCOUNT_UPDATE runs. On an UPDATING account whose other
/// values equal the change in flight only the external id is written and no
/// workflow starts. ConflictError when the account is CREATING, DELETING or
/// DELETE_FAILED. At most 100 applicationIds (ValidationException).
/// Asynchronous (ADR-045).
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/accounts/{accountId}", code: 202)
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
        /// The account, CREATING or UPDATING (or as the rotation left it).
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
/// cellCount/maxCells, whether an external id is configured, status and any
/// staged replace - the polling endpoint of the account operations.
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
// DeleteAccount - DELETE /accounts/{accountId} -> 202
// ---------------------------------------------------------------------------

/// Deregisters an empty account. One conditional write on cellCount = 0
/// moves it to DELETING - the counterpart of the cell-slot claim; an
/// occupied account is rejected with ConflictError. The ACCOUNT_DELETE
/// workflow then deletes the record; no hook can stop it. The account's
/// provisioning roles stay installed: removing them is the owner's act.
/// Asynchronous (ADR-045).
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/accounts/{accountId}", code: 202)
operation DeleteAccount {
    input := {
        /// The account to deregister.
        @required
        @httpLabel
        accountId: AccountId
    }

    output := {
        /// The account, DELETING.
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
/// one level above ListCells: owner, admitted applications,
/// cellCount/maxCells and status per account.
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
