# ADR-0022: Drain the registry on stack delete

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
The platform API creates Cognito resources at run time: a user pool per
tenant in `pool-per-tenant`, groups and users in the shared pools.
CloudFormation knows nothing about them, so `cdk destroy` deleted the stack
and left every runtime pool behind, each with a live issuer that any verifier
trusting it would keep accepting (ADR-0018). The README asked the operator to
delete every tenant first, and the integration test ran a `preDestroy` script
to do the same. Spec N-8 says teardown is total, and a blind security review
on 2026-10-22 flagged the gap.

## Options considered
### Option 1: A custom resource that offboards every tenant on Delete
Pros: `cdk destroy` is total with no manual step; the same `DeleteTenant`
sequence runs (`DELETING` first, Cognito clean-up, row removed), so the
trigger stops issuing for each tenant the moment the drain starts. Cons: a
sixth function with registry write and Cognito delete permissions; a drain
that fails leaves the stack `DELETE_FAILED` until retried.
### Option 2: A custom resource that refuses to delete while tenants exist
Pros: nothing is deleted implicitly. Cons: `cdk destroy` fails until the
operator deletes every tenant by hand, which is what the README already asked
and what people skipped.
### Option 3: Document the manual step and keep the integration test's script
Pros: no code. Cons: the orphan pool is the one leftover that keeps serving
tokens; a sample that promises total teardown should keep the promise.

## Decision
Option 1. A `Custom::TenantDrain` resource, served by its own function with
the platform function's environment, depends on the registry table and (in
the shared topologies) on the pool and app client, so CloudFormation deletes
it, and so runs it, before any of them. On Delete it pages the registry and
runs the `DeleteTenant` sequence per tenant; on Create and Update it answers
at once. Its role holds registry reads and writes and the delete side of
Cognito only: `DeleteUserPool` on this stack's tagged pools in topology 1;
list, remove, delete user and `DeleteGroup` on the shared pool in 2 and 3. No
create, tag, or sign-in action. The integration test leaves one tenant in
every stack and no longer runs a `preDestroy` script, so a leftover after the
destroy is the test's failure signal.

## Consequences
Easier: `cdk destroy` removes everything the sample created, in every
topology, with no operator step; the integration test proves it on every
run. Harder: a drain failure (for example a Cognito throttle on a registry
with many tenants) holds the delete until the resource is retried; the
function's 14-minute timeout bounds one attempt. A deployment that keeps
tenant data past the stack's life must remove this resource, which the
hardening checklist says.
