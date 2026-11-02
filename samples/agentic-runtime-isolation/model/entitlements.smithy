// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace runtimeisolation

use aws.auth#sigv4
use aws.protocols#restJson1
use smithy.framework#ValidationException

/// The entitlement API (spec §5.3, C-14; ADR-0030, ADR-0033). Two doors on
/// one service:
///
/// - the vendor's: tenant subscriptions and plans, under IAM (SigV4,
///   `execute-api:Invoke`);
/// - the tenant admin's: cuts for the users of the admin's own tenant, under
///   the tenant user's identity token, which must carry the admin scope
///   (`entitlements.adminScope`, default `entitlements/admin`). The tenant
///   comes from the verified token (or `X-Tenant-Id` among the token's
///   `tenants`), never from the path or the body (P-3).
///
/// There is no operation that adds an agent or a tool to a user's set: a
/// tenant admin can only subtract (P-12).
@title("Agentic Runtime Isolation - Entitlement API")
@restJson1
@sigv4(name: "execute-api")
@httpBearerAuth
@auth([sigv4])
service Entitlements {
    version: "2026-11-02"
    resources: [
        TenantSubscription
        Plan
        UserCut
    ]
    errors: [
        ValidationException
        ValidationError
        ForbiddenError
        UpstreamError
    ]
}

// ---------------------------------------------------------------------------
// Vendor side: tenant subscriptions (spec §4.5 row "Tenant subscription")
// ---------------------------------------------------------------------------

/// What a tenant has subscribed to, directly or through a plan (R-3).
resource TenantSubscription {
    identifiers: {
        tenantId: TenantId
    }
    put: PutTenantSubscription
    read: GetTenantSubscription
    delete: DeleteTenantSubscription
}

/// A tenant subscription row as stored.
structure TenantSubscriptionRow {
    @required
    tenantId: TenantId

    @required
    agents: AgentNameList

    @required
    tools: ToolNameList

    plan: PlanName

    @required
    status: SubscriptionStatus

    @required
    version: RowVersion

    @required
    updatedAt: IsoTimestamp
}

/// Writes the whole row and increments `version`. Every name must be a
/// reserved agent name or a catalogued tool (or `<target>/*` for a
/// catalogued target), else 400 `unknown_name`.
@idempotent
@auth([sigv4])
@http(method: "PUT", uri: "/entitlements/tenants/{tenantId}")
operation PutTenantSubscription {
    input := {
        @required
        @httpLabel
        tenantId: TenantId

        @required
        agents: AgentNameList

        @required
        tools: ToolNameList

        plan: PlanName

        status: SubscriptionStatus
    }

    output := {
        @required
        subscription: TenantSubscriptionRow
    }

    errors: [
        ResourceNotFoundError
    ]
}

@readonly
@auth([sigv4])
@http(method: "GET", uri: "/entitlements/tenants/{tenantId}")
operation GetTenantSubscription {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        @required
        subscription: TenantSubscriptionRow
    }

    errors: [
        ResourceNotFoundError
    ]
}

/// Deletes the tenant row and every cut row of the tenant.
@idempotent
@auth([sigv4])
@http(method: "DELETE", uri: "/entitlements/tenants/{tenantId}", code: 204)
operation DeleteTenantSubscription {
    input := {
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {}
}

// ---------------------------------------------------------------------------
// Vendor side: plans (spec §4.5 row "Plan")
// ---------------------------------------------------------------------------

/// A named bundle of agents and tools a tenant row may reference.
resource Plan {
    identifiers: {
        planName: PlanName
    }
    put: PutPlan
    read: GetPlan
    delete: DeletePlan
    list: ListPlans
}

/// A plan row as stored.
structure PlanRow {
    @required
    planName: PlanName

    @required
    agents: AgentNameList

    @required
    tools: ToolNameList

    @required
    version: RowVersion

    @required
    updatedAt: IsoTimestamp
}

@length(max: 100)
list PlanRowList {
    member: PlanRow
}

@idempotent
@auth([sigv4])
@http(method: "PUT", uri: "/entitlements/plans/{planName}")
operation PutPlan {
    input := {
        @required
        @httpLabel
        planName: PlanName

        @required
        agents: AgentNameList

        @required
        tools: ToolNameList
    }

    output := {
        @required
        plan: PlanRow
    }
}

@readonly
@auth([sigv4])
@http(method: "GET", uri: "/entitlements/plans/{planName}")
operation GetPlan {
    input := {
        @required
        @httpLabel
        planName: PlanName
    }

    output := {
        @required
        plan: PlanRow
    }

    errors: [
        ResourceNotFoundError
    ]
}

/// Refused with 409 `plan_in_use` while a tenant row names the plan.
@idempotent
@auth([sigv4])
@http(method: "DELETE", uri: "/entitlements/plans/{planName}", code: 204)
operation DeletePlan {
    input := {
        @required
        @httpLabel
        planName: PlanName
    }

    output := {}

    errors: [
        ConflictError
    ]
}

@readonly
@auth([sigv4])
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "plans")
@http(method: "GET", uri: "/entitlements/plans")
operation ListPlans {
    input := {
        @httpQuery("nextToken")
        nextToken: PaginationToken
    }

    output := {
        @required
        plans: PlanRowList

        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// Tenant-admin side: user cuts (spec §4.5 row "User cut", ADR-0033)
// ---------------------------------------------------------------------------

/// What a tenant admin has taken away from one user of the admin's own
/// tenant. A user with no cut holds the tenant's full set (P-12).
resource UserCut {
    identifiers: {
        sub: UserSub
    }
    put: PutUserCut
    read: GetUserCut
    delete: DeleteUserCut
    list: ListUserCuts
}

/// A cut row as stored. It has no field that adds anything.
structure UserCutRow {
    @required
    sub: UserSub

    @required
    tenantId: TenantId

    @required
    cutAgents: AgentNameList

    @required
    cutTools: ToolNameList

    @required
    version: RowVersion

    /// The admin's own `sub`.
    @required
    updatedBy: UserSub

    @required
    updatedAt: IsoTimestamp
}

@length(max: 100)
list UserCutRowList {
    member: UserCutRow
}

/// Writes the cut and bumps the tenant row's `version` in one transaction.
/// Every name must be something the tenant holds, else 400
/// `not_subscribed`.
@idempotent
@auth([httpBearerAuth])
@http(method: "PUT", uri: "/entitlements/users/{sub}/cut")
operation PutUserCut {
    input := {
        @required
        @httpLabel
        sub: UserSub

        /// Selects one of the token's `tenants`; checked against the token
        /// when it carries `tenant_id` (P-3).
        @httpHeader("X-Tenant-Id")
        tenantId: TenantId

        @required
        cutAgents: AgentNameList

        @required
        cutTools: ToolNameList
    }

    output := {
        @required
        cut: UserCutRow
    }

    errors: [
        ResourceNotFoundError
    ]
}

@readonly
@auth([httpBearerAuth])
@http(method: "GET", uri: "/entitlements/users/{sub}/cut")
operation GetUserCut {
    input := {
        @required
        @httpLabel
        sub: UserSub

        @httpHeader("X-Tenant-Id")
        tenantId: TenantId
    }

    output := {
        @required
        cut: UserCutRow
    }

    errors: [
        ResourceNotFoundError
    ]
}

/// Removes the cut: the user holds the full tenant set again.
@idempotent
@auth([httpBearerAuth])
@http(method: "DELETE", uri: "/entitlements/users/{sub}/cut", code: 204)
operation DeleteUserCut {
    input := {
        @required
        @httpLabel
        sub: UserSub

        @httpHeader("X-Tenant-Id")
        tenantId: TenantId
    }

    output := {}
}

/// The cuts of the caller's own tenant only.
@readonly
@auth([httpBearerAuth])
@paginated(inputToken: "nextToken", outputToken: "nextToken", items: "cuts")
@http(method: "GET", uri: "/entitlements/users")
operation ListUserCuts {
    input := {
        @httpHeader("X-Tenant-Id")
        tenantId: TenantId

        @httpQuery("nextToken")
        nextToken: PaginationToken
    }

    output := {
        @required
        cuts: UserCutRowList

        nextToken: PaginationToken
    }
}
