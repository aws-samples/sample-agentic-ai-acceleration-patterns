# ADR-0005: Mutations that end in CodeBuild are async (202) via Step Functions

**Status:** Accepted — amended by ADR-0045 (application, tenant and account mutations are asynchronous too, with no build)

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

**Amended by ADR-0045 (2026-11-18):** the mutations of applications, tenants and accounts run no build and are asynchronous all the same, so that pre hooks can gate them. `PutApplication`, `DeleteApplication`, `CreateTenant`, `UpdateTenant`, `DeleteTenant`, `PutAccount` and `DeleteAccount` answer 202 and start one execution of the same workflow, which runs the event's hooks, commits the change and writes the terminal status; callers poll the record's `Get` operation. The three record types gain the transitional statuses, which guard them with 409s as they guard cells and deployments. The one exception is a `PutAccount` that rotates the external id of an `UPDATING` account: it writes the id, answers 202 and starts no execution. Hook operations stay synchronous.
