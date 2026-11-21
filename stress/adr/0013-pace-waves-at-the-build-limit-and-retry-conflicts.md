<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0013: Pace waves at the build limit and retry conflicts

- Status: Accepted
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

Two choices follow: how the driver handles a conflict (options 1 to 3), and how it sends a
wave of creates and deletes while the control plane refuses builds over the limit (options
4 to 6).

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

### Option 4: Send each wave unpaced and count the refused builds
Every create or delete of a wave goes out at once, and a deployment that ends
`CREATE_FAILED` or `DELETE_FAILED` on a refused build is counted. Pros: the driver acts as
a client that trusts ADR-0046; no pacing code. Cons: at a limit below the wave size the
scenario measures the workflow's retry window, not the onboarding rate, and every such
run fails on a refusal the control plane documents the other way.

### Option 5: Pace each wave at the build limit
The driver keeps at most the build limit of creates and deletes in flight and starts the
next one as one settles. Pros: what any client must do while the control plane does not
queue builds; build-limit scaling measures the onboarding rate at each limit, which is
what spec §5.2 asks. Cons: the driver works around a control-plane defect, so a run no
longer shows the refusal; the finding has to carry it.

### Option 6: Raise the build limit above the wave size
Pros: no pacing and no refusals. Cons: build-limit scaling exists to compare limits 5, 20
and 50, so a fixed high limit removes what it measures, and every run then needs the
CodeBuild quota for the larger limit.

## Decision
Option 1 and Option 5. Option 3 goes to the control-plane owner as a finding
(control-plane README, Known issues). The same rule covers the workflow's terminal
writes: a deployment that ends `CREATE_FAILED` or `DELETE_FAILED` with a
`TransactionCanceledException` reason is removed and created again, or deleted again, at
most twice, and each retry is counted under `requests` as `CREATE_FAILED:retried` or
`DELETE_FAILED:retried`. A failure with any other reason fails the scenario at once.

Every wave of creates and deletes keeps at most the build limit in flight. The refused
`StartBuild` goes to the control-plane owner as a finding (the same Known issues): either
the workflow waits and retries until a build slot is free, or ADR-0046 and the README say
that a client must stay under the limit.

The slice run `20261120T142632Z` (stress application README, Results) picked both. Paced
at limit 5, build-limit scaling placed its 20 deployments in 152 s with no refused build,
where the unpaced second run had builds refused and deployments `CREATE_FAILED`. Option 6
could not have given the 152 s, 49 s and 48 s the scenario compares across limits. With
the retries, every scenario passed with no unattributed request, and the record shows the
conflicts it met as two `DELETE_FAILED:retried`.

## Consequences
The slice's records show `500:internal-server` requests, `ambiguous-placement` refusals
and `CREATE_FAILED:retried` and `DELETE_FAILED:retried` counts; the control-plane README's
stress section says how to read them. If the control plane adopts Option 3, they drop to
zero and the special case can go.
