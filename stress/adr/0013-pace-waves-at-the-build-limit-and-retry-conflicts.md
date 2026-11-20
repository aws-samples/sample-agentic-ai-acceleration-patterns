<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Pace waves at the build limit and retry conflicts

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
The first control-plane slice run (PS-1, 2026-11-20) placed 19 tenants at once on one
ACTIVE cell. Two `CreateDeployment` calls answered 500 `InternalServerError`, "Deployment
placement failed ambiguously". Concurrent claims on one cell item can cancel a
`TransactWriteItems` with `TransactionConflict` and no failed condition. The control plane
treats such a cancellation as an unknown outcome and fails the request without
retargeting it (control-plane spec §7; `repository.test.ts` pins it). The contract for
that case is a client retry with the same `clientToken`, which replays the outcome instead
of placing twice.

The same run's build-limit scaling removed 20 deployments of one cell at once. Some of them
ended `DELETE_FAILED` with "Tenant delete failed: DynamoDb.TransactionCanceledException":
the workflow's terminal transaction, which releases the cell slot, met another delete's on
the same cell item. Its tenant build had succeeded. A `DELETE_FAILED` deployment takes
another delete (the control plane README, Teardown).

The second run's build-limit scaling placed 20 deployments at once at a build limit of 5.
CodeBuild does not queue builds over a project's concurrent build limit: it refuses the
`StartBuild` with `AccountLimitExceededException` ("This build project has a limit of 5
concurrent build(s)"). The workflow retried a few times, about 30 seconds apart, then
failed the operation, so some deployments ended `CREATE_FAILED` and some deletes
`DELETE_FAILED`. Control-plane ADR-0046 and the stack's comment say that excess builds
queue.

P-7 asks that every refusal names a tenant and a reason, and that a bare 500 is a finding.
This 500 names its reason, and the driver knows its tenant.

## Options considered
### Option 1: Retry with the client token and attribute the 500
Every `CreateDeployment` carries a client token per placement, the same on each retry. A
500 with the ambiguous-placement message is retried like a lost claim race and counted as
a refusal of its tenant with the reason `ambiguous-placement`. Any other 5xx stays
unattributed. Pros: the driver uses the API as its contract says; the count of ambiguous
placements stays in every record, by tenant. Cons: a run with them passes, so a rise in
their number is seen in the records, not as a failure.

### Option 2: Count it as unattributed
Pros: strict. Cons: every run at a build limit above a handful fails on documented,
retryable behaviour, and the scenario never gets past it to what it measures.

### Option 3: Change the control plane to treat a conflict as a lost race
Pros: no 500 at all; a cancelled transaction did not apply. Cons: a change to a decision of
the control-plane sample, outside the stress test; it needs its own review.

## Decision
Option 1, and Option 3 goes to the control-plane owner as a finding (control-plane README, Known issues). The same rule covers
the workflow's terminal writes: a deployment that ends `CREATE_FAILED` or `DELETE_FAILED`
with a `TransactionCanceledException` reason is removed and created again, or deleted
again, at most twice, and each retry is counted under `requests` as
`CREATE_FAILED:retried` or `DELETE_FAILED:retried`. A failure with any other reason fails
the scenario at once.

Every wave of creates and deletes keeps at most the build limit in flight, as any client
must while the control plane does not queue builds. That makes build-limit scaling measure
the onboarding rate at each limit, which is what spec §5.2 asks. The refused `StartBuild`
goes to the control-plane owner as a finding (the same Known issues): either the workflow waits and retries until a
build slot is free, or ADR-0046 and the README say that a client must stay under the limit.

## Consequences
The slice's records show `500:internal-server` requests, `ambiguous-placement` refusals
and `CREATE_FAILED:retried` and `DELETE_FAILED:retried` counts; the control-plane README's stress section says how to
read them. If the control plane adopts Option 3,
they drop to zero and the special case can go.
