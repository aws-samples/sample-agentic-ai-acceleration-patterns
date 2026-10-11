# ADR-0005: Mutations that end in CodeBuild are async (202) via Step Functions

**Status:** Accepted

**Context:** Provisioning scripts run in CodeBuild and may take minutes to
hours (real infrastructure — CloudFormation and the like). Synchronous API
Gateway calls cap at 29 seconds. A plain Lambda waiter was considered and
rejected: Lambda's 15-minute invocation cap is exceeded by exactly the builds
that most need bookkeeping, Lambda bills the entire wait as compute, and a
crash mid-wait loses the terminal transition (no durable execution).

**Decision:** `CreateTenant`, `DeleteTenant`, `UpdateResource` return HTTP 202
after persisting a transitional status (`CREATING`/`DELETING`/`UPDATING`).
A Step Functions workflow runs `StartBuild` with the `.sync` integration
(free while waiting, durable, checkpointed) and writes terminal state.
`GetTenant` is the polling endpoint. `UpdateTenant` is the one synchronous
mutation (metadata only, no build).

**Consequences:** Matches the sync-Lambda/async-Step-Functions convention.
Transitional status doubles as an optimistic concurrency guard: mutations on
an in-flight tenant return 409. No callback/webhook plumbing —
`startBuild.sync` handles completion.
