// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Hook resource
// ---------------------------------------------------------------------------

/// A global hook (ADR-044): vendor code the workflow runs before or after a
/// cell or deployment script, for every application. Registered through the
/// API by an operator, never by a tenant or an application; an application's
/// own hooks are part of its definition (PutApplication) and are stamped onto
/// its cells. The control plane keeps the authoritative count of global
/// hooks (at most five), claimed in the transaction that creates a hook and
/// released in the one that deletes it. A hook has no status: its operations
/// are synchronous and run no build, and there is no operation that runs one.
resource Hook {
    identifiers: {
        hookId: HookId
    }
    put: PutHook
    read: GetHook
    delete: DeleteHook
    list: ListHooks
}

// ---------------------------------------------------------------------------
// Hook types. Every pattern admits no control character and no character
// JSON escapes (`"`, `\`), so a definition is as large in the workflow's
// execution input as it is raw (spec R-39, §8.1). They are the patterns of
// src/tenant/hook.types.ts, which the service checks again.
// ---------------------------------------------------------------------------

/// Operator-chosen hook identifier: lower-case letters, digits and hyphens.
/// It orders hooks within a scope - hooks run in ascending id (R-45).
@pattern("^[a-z0-9-]{1,32}$")
string HookId

/// An event a hook can run around: three per build, CELL_* for the cell
/// build and DEPLOYMENT_* for the tenant build.
enum HookEvent {
    /// Around the cell create build, when placement creates a cell.
    CELL_CREATE
    /// Around the cell update build (UpdateCell).
    CELL_UPDATE
    /// Around the cell delete build (DeleteCell).
    CELL_DELETE
    /// Around the tenant create build (CreateDeployment).
    DEPLOYMENT_CREATE
    /// Around the tenant update build (UpdateDeployment).
    DEPLOYMENT_UPDATE
    /// Around the tenant delete build (DeleteDeployment).
    DEPLOYMENT_DELETE
}

/// When a hook runs relative to the script of its event.
enum HookPhase {
    /// Before the script.
    PRE
    /// After the script succeeded.
    POST
}

/// The events a hook runs on: at least one, each at most once.
@length(min: 1, max: 6)
@uniqueItems
list HookEventList {
    member: HookEvent
}

/// Location of a hook's source: URL characters without `@`, so it carries no
/// userinfo (https://user:token@host/... is refused), or bucket/path for S3.
@length(min: 1, max: 1024)
@pattern("^[A-Za-z0-9._~:/?#\\[\\]!$&'()*+,;=%-]+$")
string HookSourceLocation

/// A git ref, commit SHA or object version of a hook's source: the characters
/// of a branch, a tag (a SemVer `+` included), a commit SHA or a
/// `<ref>^{<commit>}` pin. A ref that is not a full commit SHA is accepted
/// with a logged warning naming the hook (ADR-020).
@length(min: 1, max: 128)
@pattern("^[A-Za-z0-9._/^{}+-]+$")
string HookSourceVersion

/// Path of a hook's script within its source.
@length(min: 1, max: 256)
@pattern("^[A-Za-z0-9._/-]+$")
string HookScriptPath

/// A hook build's run timeout in minutes. CodeBuild's override minimum is 5.
@range(min: 5, max: 30)
integer HookTimeoutMinutes

/// How many times a global hook was registered or replaced: 1 on create,
/// incremented by every replace.
@range(min: 1)
integer HookRevision

/// A hook's source: the shape of an application's source, with the hook
/// charsets and limits.
structure HookSource {
    /// The repository type containing the hook script.
    @required
    type: SourceType

    /// The source location (HTTPS clone URL without userinfo, or bucket/path).
    @required
    location: HookSourceLocation

    /// Optional git ref, commit SHA or object version. Absent, the hook
    /// runs the source's default branch HEAD.
    sourceVersion: HookSourceVersion
}

/// One hook definition, the shape of a global hook and of one entry in an
/// application's hooks list. Carries no secret: every read operation returns
/// it to operators and readers alike (spec R-39, N-12).
structure HookDefinition {
    /// The hook id: unique among global hooks, or within the application's
    /// list.
    @required
    hookId: HookId

    /// The events the hook runs on.
    @required
    events: HookEventList

    /// Whether the hook runs before or after the script.
    @required
    phase: HookPhase

    /// Where the hook script is fetched from.
    @required
    source: HookSource

    /// The hook script, relative to the source root.
    @required
    script: HookScriptPath

    /// The hook build's run timeout in minutes, 5 to 30. Sent absent, the
    /// default of 10 is stored; always present in a response.
    timeoutMinutes: HookTimeoutMinutes
}

/// An application's hooks, at most five. Hook ids are unique in the list
/// (ValidationException otherwise).
@length(max: 5)
list HookDefinitionList {
    member: HookDefinition
}

/// A global hook as returned by the API: its definition, revision and
/// timestamps.
structure HookSummary {
    /// The hook id.
    @required
    hookId: HookId

    /// The events the hook runs on.
    @required
    events: HookEventList

    /// Whether the hook runs before or after the script.
    @required
    phase: HookPhase

    /// Where the hook script is fetched from.
    @required
    source: HookSource

    /// The hook script, relative to the source root.
    @required
    script: HookScriptPath

    /// The hook build's run timeout in minutes.
    @required
    timeoutMinutes: HookTimeoutMinutes

    /// 1 on create, incremented by every replace. Never supplied.
    @required
    revision: HookRevision

    /// When the hook was registered.
    @required
    createdAt: IsoTimestamp

    /// When the hook was last replaced.
    @required
    updatedAt: IsoTimestamp
}

/// A page of global hooks, in hook id order - the order they run in.
list HookList {
    member: HookSummary
}

/// The commit a hook build ran, as the final poll reported it: the full SHA
/// for a git source, also when the hook names a branch.
@length(min: 1, max: 256)
string ResolvedSourceVersion

/// A global hook that ran for a cell's or a deployment's last event
/// (spec R-40): which hook, in which phase, at which revision, and the ref it
/// named and the commit its build ran, so an operator can tell which commit
/// of a gate or audit hook an ACTIVE record passed.
@references([{resource: Hook}])
structure LastGlobalHook {
    /// The hook id.
    @required
    hookId: HookId

    /// The phase the hook ran in.
    @required
    phase: HookPhase

    /// The revision of the hook the execution ran.
    @required
    revision: HookRevision

    /// The ref the hook names. Absent when its source names none.
    sourceVersion: HookSourceVersion

    /// The commit its build ran. Absent for an S3 source, whose build
    /// reports none.
    resolvedSourceVersion: ResolvedSourceVersion
}

/// The global hooks that ran for the record's last event, in run order;
/// empty when none ran. Written by the workflow's terminal writes only.
list LastGlobalHookList {
    member: LastGlobalHook
}

// ---------------------------------------------------------------------------
// PutHook - PUT /hooks/{hookId} -> 200
// ---------------------------------------------------------------------------

/// Registers a global hook or replaces it (create-or-replace). The
/// definition is validated as a whole (ValidationException on an unknown
/// event, phase or source type, an empty or repeating event list, a field
/// outside its pattern, a location with userinfo, a timeout outside 5 to 30).
/// A create claims a slot of the hook counter in the same transaction; a sixth
/// hook is a ConflictError that says to delete a hook first. A replace
/// increments the revision. A put that raced a create or delete of the same
/// hook is a ConflictError to retry. Takes effect on operations accepted
/// afterwards; executions in flight keep the snapshot they were accepted with.
/// A source ref that is not a full commit SHA is accepted with a logged
/// warning naming the hook. Operator only. Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/hooks/{hookId}", code: 200)
operation PutHook {
    input := {
        /// The hook to register.
        @required
        @httpLabel
        hookId: HookId

        /// The events the hook runs on.
        @required
        events: HookEventList

        /// Whether the hook runs before or after the script.
        @required
        phase: HookPhase

        /// Where the hook script is fetched from.
        @required
        source: HookSource

        /// The hook script, relative to the source root.
        @required
        script: HookScriptPath

        /// The hook build's run timeout in minutes, 5 to 30. Default 10.
        timeoutMinutes: HookTimeoutMinutes
    }

    output := {
        /// The registered hook.
        @required
        hook: HookSummary
    }

    errors: [
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// GetHook - GET /hooks/{hookId} -> 200
// ---------------------------------------------------------------------------

/// Returns a registered global hook: its definition, revision and timestamps.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/hooks/{hookId}", code: 200)
operation GetHook {
    input := {
        /// The hook to fetch.
        @required
        @httpLabel
        hookId: HookId
    }

    output := {
        /// The requested hook.
        @required
        hook: HookSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// DeleteHook - DELETE /hooks/{hookId} -> 200
// ---------------------------------------------------------------------------

/// Deletes a global hook and releases its slot of the hook counter in one
/// transaction. No guard on executions in flight: each runs the snapshot it
/// was accepted with, and StopExecution is the only stop for them.
/// ResourceNotFoundError when the hook is not registered. Operator only.
/// Synchronous.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/hooks/{hookId}", code: 200)
operation DeleteHook {
    input := {
        /// The hook to delete.
        @required
        @httpLabel
        hookId: HookId
    }

    output := {
        /// The hook as it was before deletion.
        @required
        hook: HookSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// ListHooks - GET /hooks -> 200
// ---------------------------------------------------------------------------

/// Lists the registered global hooks with pagination, in hook id order -
/// the order global hooks run in.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "hooks")
@http(method: "GET", uri: "/hooks", code: 200)
operation ListHooks {
    input := {
        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of hooks to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of hooks.
        @required
        hooks: HookList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}
