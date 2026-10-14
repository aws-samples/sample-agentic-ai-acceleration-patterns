# ADR-0004: Make platform mutations synchronous

- Status: Accepted
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The `control-plane` sample makes every mutation that ends in a build
asynchronous (202, transitional status, polling), because builds take
minutes. This sample's slowest mutation is creating a Cognito user pool with
an app client and a trigger attachment in `pool-per-tenant`, which completes
in seconds, and tenant deletion, which may delete tens of users.

## Options considered
### Option 1: Asynchronous, as in `control-plane` (Step Functions, 202, status polling)
Pros: consistent with the sibling sample; tolerant of slow Cognito clean-up.
Cons: a workflow service, a transitional status, and a polling contract added
for operations that finish inside an API timeout; the sample would teach
machinery that its own problem does not need (P-1 in `control-plane`'s
terms: a boundary that adds machinery without capability).
### Option 2: Synchronous request/response, with `DeleteTenant` idempotent and re-runnable
Pros: simplest correct shape; `DeleteTenant` flips the registry status first
(R-9), so a partial failure leaves a `DELETING` tenant that a retry
completes, and the resolver already rejects it. Cons: a tenant with
thousands of users would exceed the function timeout on delete; the sample
documents that bound.

## Decision
Option 2. All platform operations return their final state. `DeleteTenant`
is a two-phase, idempotent operation (status flip, Cognito clean-up, item
removal) and the README states the user-count bound at which a deployer
should move deletion behind the control-plane workflow (spec §11, async
onboarding seam).

## Consequences
Easier: the Smithy model has no status state machine; the integration test
needs no polling. Harder: very large tenants need the async seam. Revisit
when onboarding grows to provision more than identity (tenant storage,
per-tenant infrastructure), at which point the sample should mount into the
`control-plane` sample's workflow rather than grow its own.
