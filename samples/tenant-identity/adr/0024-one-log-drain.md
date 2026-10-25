# ADR-0024: Use one log drain whose writers are what invokes the functions

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)
- Supersedes: [ADR-0019](0019-teardown-leaves-no-log-group.md) (the two-drain layout only)

## Context
ADR-0019 holds back log-group deletion with a `LogDrain` custom resource:
writers depend on it, it depends on the log groups, and on delete it waits
90 seconds. It used two drains, one whose writers were the six functions and
one for the API stage, because the execution log group's name holds the API
id and the API references the functions: one drain with the functions as
writers would be a dependency cycle. CloudFormation events from the
2026-10-22 run show the cost. The drains wait one after the other (the
functions drain cannot start until the API, and so the stage drain, is
gone), adding about 200 s to every `cdk destroy`. On create, every
function's role and policy waited for the functions drain, about 30 s more.

A function writes logs only when something invokes it. In this stack that is
the API stage (four functions), Cognito (the trigger), and CloudFormation
(the `TenantDrain` function, ADR-0022). Deleting the function first does not
add anything once its callers are gone.

## Options considered
### Option 1: Keep two drains
Pros: no change. Cons: two serial waits on every destroy.
### Option 2: One drain; writers are the stage, `TenantDrain`, and the shared pool
Pros: one wait. Cons: the shared pool cannot be a writer. The functions
reference the pool, and the API references the functions, so the pool
waiting on a drain that guards the execution log group is a cycle.
### Option 3: One drain; writers are the stage and `TenantDrain`
Pros: one wait; no cycle; the functions no longer wait for the drain on
create. Cons: in the shared topologies the pool is deleted after the drain,
so a direct Cognito sign-in in the last seconds before teardown could still
run the trigger and log late. Nothing in the sample does that during a
destroy.

## Decision
Option 3. One `LogDrain` protects the six function log groups, the API
access log group and the execution log group. Its writers are the API stage
and `TenantDrain`. `TenantDrain` covers the trigger in `pool-per-tenant`:
it deletes the runtime pools that invoke it. The 90-second wait,
the waiter that writes no logs, the owned execution log group, and
`cloudWatchRole: false` stay as ADR-0019 decided.

## Consequences
Easier: `cdk destroy` waits once, about 100 s faster per stack; functions
create about 30 s sooner. Harder: the guard now rests on the writer list
being complete. A new caller of a function (an event source, a schedule, a
new pool) must become a writer, and the CDK test that lists the writers must
change with it. A direct sign-in to the shared pool during teardown is not
covered. Revisit if a leftover function log group appears after a destroy.
