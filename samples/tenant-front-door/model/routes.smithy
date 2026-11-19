// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace tenantfrontdoor

// ---------------------------------------------------------------------------
// Cell route: `cell#<cellId>` (§4.1)
// ---------------------------------------------------------------------------

/// The route to one cell's API origin.
resource CellRoute {
    identifiers: {
        cellId: CellId
    }
    put: PutCellRoute
    delete: DeleteCellRoute
}

/// Puts the cell's route. The global hook role calls it on cell create and
/// update with the cell script's `frontDoorApiDomain` output; the edge
/// operator role calls it to backfill or change an origin. The account
/// comes from the control plane, never the body. For the global hook role,
/// 409 while the cell is neither `CREATING` nor `UPDATING`, and 409 when the
/// stored origin differs: the origin is write-once for it (§3.4).
@idempotent
@http(method: "PUT", uri: "/cells/{cellId}", code: 200)
operation PutCellRoute {
    input := {
        @required
        @httpLabel
        cellId: CellId

        /// The cell's API origin host.
        @required
        apiDomain: ApiDomain
    }

    output := {
        @required
        cellId: CellId

        @required
        apiDomain: ApiDomain
    }

    errors: [
        UnprocessableError
        InsufficientStorageError
    ]
}

/// Deletes the cell's route. For the global hook role, 409 while the cell
/// is neither missing nor `DELETING`. Does not look for tenant routes that
/// name the cell. 200, also when absent.
@idempotent
@http(method: "DELETE", uri: "/cells/{cellId}", code: 200)
operation DeleteCellRoute {
    input := {
        @required
        @httpLabel
        cellId: CellId
    }

    output := {}
}

// ---------------------------------------------------------------------------
// Tenant route: `tenant#<tenantId>` and its `host#` keys (§4.1)
// ---------------------------------------------------------------------------

/// The route of one tenant's deployment to its cell, its status, and in
/// `host` mode its pooled host.
resource TenantRoute {
    identifiers: {
        tenantId: TenantId
    }
    put: PutTenantRoute
    delete: DeleteTenantRoute
    operations: [
        UpdateTenantRouteStatus
    ]
}

/// Where a dedicated domain stands (§5.1).
enum DomainStage {
    /// The challenge record is not yet published with this tenant's token.
    DOMAIN_CHALLENGE = "domain-challenge"

    /// The ACM certificate is waiting for its validation record.
    CERTIFICATE = "certificate"

    /// The certificate issued, but the challenge record no longer holds the
    /// token at the final check; no `host#` key is written.
    CHALLENGE_RECHECK = "challenge-recheck"
}

/// The last resolution of the challenge record. `unresolved` is a resolver
/// error, never a pass.
enum ChallengeResult {
    MISSING = "missing"
    MISMATCH = "mismatch"
    UNRESOLVED = "unresolved"
}

/// A DNS record the tenant publishes.
structure DnsRecord {
    /// Fully qualified record name.
    @required
    name: String

    /// `TXT` for the domain challenge, `CNAME` for ACM validation.
    @required
    type: String

    @required
    value: String
}

/// Puts the tenant's route. The global hook role calls it on deployment
/// create and update; the display name, cell and account come from the
/// control plane, and the entry records the deployment's `createdAt` as
/// `dt`. A new entry starts `active`; a write to an existing entry keeps its
/// status. A hook put whose `createdAt` differs from the stored `dt`
/// replaces the entry as a new one (§3.4 step 5). Only the edge operator
/// role may send `customDomain` (403 for the global hook role), and only
/// while `dedicatedDomains` is on (400 otherwise). 200 with `dt` once
/// routed; 202 while a dedicated domain is pending (`stage`, `record`,
/// `challenge`).
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}", code: 200)
operation PutTenantRoute {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        /// The tenant's dedicated domain; absent drops it. Edge operator
        /// role only.
        customDomain: CustomDomain
    }

    output := {
        /// 200 once routed, 202 while a dedicated domain is pending.
        @httpResponseCode
        @required
        statusCode: Integer

        @required
        tenantId: TenantId

        /// The stored `dt`: the deployment's `createdAt` in Unix ms. The
        /// route hook compares it with `/config.json`'s `rev` (§4.2).
        @required
        dt: DeploymentRevision

        /// Present with 202.
        stage: DomainStage

        /// The record the tenant publishes next: the challenge TXT record
        /// (`_tfd-challenge.<d>` `tfd-verify=<token>`) or ACM's validation
        /// record. Present with 202.
        record: DnsRecord

        /// Present with 202 for `domain-challenge` and `challenge-recheck`.
        challenge: ChallengeResult
    }

    errors: [
        UnprocessableError
        InsufficientStorageError
    ]
}

/// Deletes the tenant's route: the `tenant#` key, its pooled `host#` key
/// and the `host#<d>` key its `d` names, each `host#` key only when its `t`
/// names the tenant. Disables the dedicated distribution tenant; the
/// sweeper deletes it and its certificate. For the global hook role, 409
/// while the deployment is neither missing nor `DELETING`. 200, also when
/// absent.
@idempotent
@http(method: "DELETE", uri: "/tenants/{tenantId}", code: 200)
operation DeleteTenantRoute {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {}
}

/// A route status (§4.2). Removal is a delete, not a status.
enum RouteStatus {
    ACTIVE = "active"
    SUSPENDED = "suspended"
}

/// Sets the tenant route's status. Edge operator role only.
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}/status", code: 200)
operation UpdateTenantRouteStatus {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        status: RouteStatus
    }

    output := {
        @required
        tenantId: TenantId

        @required
        status: RouteStatus
    }
}

// ---------------------------------------------------------------------------
// Host route: `host#<host>` (§4.1)
// ---------------------------------------------------------------------------

/// One `host#` key.
resource HostRoute {
    identifiers: {
        host: HostName
    }
    delete: DeleteHostRoute
}

/// Removes one `host#` key whatever its `t` and `ac`, and the `d` of the
/// tenant it names when `d` is that host, to clear a key left behind. Edge
/// operator role only. 200, also when absent.
@idempotent
@http(method: "DELETE", uri: "/hosts/{host}", code: 200)
operation DeleteHostRoute {
    input := {
        @required
        @httpLabel
        host: HostName
    }

    output := {}
}
