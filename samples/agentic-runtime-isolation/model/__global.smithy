// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

// Operation names use the AWS lifecycle verbs only (spec §5.3, C-14;
// docs/sample-standard.md §4.2). DANGER makes a bad name fail `smithy build`.
metadata validators = [
    {
        name: "StandardOperationVerb"
        severity: "DANGER"
        configuration: {
            verbs: ["Create", "Get", "Update", "Delete", "List", "Put"]
            suggestAlternatives: {
                Read: ["Get"]
                Fetch: ["Get"]
                Describe: ["Get"]
                Add: ["Create"]
                Remove: ["Delete"]
            }
        }
    }
]

// The cut row and the user-cut operations name the tenant they belong to;
// the tenant is not a sub-resource of the subscription (one row each, spec
// §4.5), so a @references trait would be wrong.
metadata suppressions = [
    {
        id: "MemberShouldReferenceResource"
        namespace: "runtimeisolation"
        reason: "A cut row carries its tenant id as data; the tenant subscription is a separate resource keyed by the same id (spec §4.5)."
    }
]

namespace runtimeisolation

// ---------------------------------------------------------------------------
// Common types (spec §3.3, §4.5)
// ---------------------------------------------------------------------------

/// A tenant id as tenant-identity issues it (ULID).
@pattern("^[0-9A-HJKMNP-TV-Z]{26}$")
string TenantId

/// A tenant user's identity-provider `sub`. Never a tenant-qualified value.
@length(min: 1, max: 128)
@pattern("^[A-Za-z0-9._@+-]+$")
string UserSub

/// An agent product name: the `AgentBackend` name (ADR-0032).
@pattern("^[a-z0-9-]{1,32}$")
string AgentName

/// A tool name, `<target>/<tool>`, or `<target>/*` for every tool of one
/// target (spec §3.5, ADR-0035).
@length(min: 3, max: 97)
@pattern("^[a-z0-9-]{1,32}/([a-z0-9_]{1,64}|\\*)$")
string ToolName

/// A plan name.
@pattern("^[a-z0-9-]{1,32}$")
string PlanName

/// Agent names in a tenant or plan row. The deploy-time bound
/// `entitlements.maxAgentsPerTenant` may be lower.
@length(max: 100)
@uniqueItems
list AgentNameList {
    member: AgentName
}

/// Tool names in a tenant or plan row. The deploy-time bound
/// `entitlements.maxToolsPerTenant` may be lower.
@length(max: 1000)
@uniqueItems
list ToolNameList {
    member: ToolName
}

/// A row's version: incremented by every write (ADR-0036).
@range(min: 1)
integer RowVersion

/// ISO 8601 timestamp.
@timestampFormat("date-time")
timestamp IsoTimestamp

/// Opaque pagination token.
@length(min: 1, max: 4096)
string PaginationToken

/// Whether a tenant may use anything at all (spec §4.5).
enum SubscriptionStatus {
    ACTIVE = "active"
    SUSPENDED = "suspended"
}

// ---------------------------------------------------------------------------
// Errors (spec §5.3)
// ---------------------------------------------------------------------------

/// Why a request was refused as invalid. The value is the fixed reason
/// code of spec §5.3; it never echoes input.
enum ValidationReason {
    /// A name is neither a reserved agent name nor a catalogued tool.
    UNKNOWN_NAME = "unknown_name"

    /// A cut names an agent or tool the tenant does not hold (ADR-0033).
    NOT_SUBSCRIBED = "not_subscribed"

    /// A list is longer than the deploy-time bound.
    TOO_MANY = "too_many"

    /// The token names several tenants and no `X-Tenant-Id` was sent.
    TENANT_REQUIRED = "tenant_required"

    /// Any other invalid input.
    INVALID_INPUT = "invalid_input"
}

/// Malformed input.
@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String

    @required
    reason: ValidationReason
}

/// The caller may not perform the operation (for example a tenant admin
/// without the admin scope, `admin_scope_missing`).
@error("client")
@httpError(403)
structure ForbiddenError {
    @required
    message: String

    @required
    reason: String
}

/// No such row.
@error("client")
@httpError(404)
structure ResourceNotFoundError {
    @required
    message: String
}

/// The request conflicts with current state (for example `plan_in_use`).
@error("client")
@httpError(409)
structure ConflictError {
    @required
    message: String

    @required
    reason: String
}

/// The entitlement store could not be read or written.
@error("server")
@httpError(502)
structure UpstreamError {
    @required
    message: String
}
