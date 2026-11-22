<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0020: Time a tenant to its first served API call, and keep the warm-up tenant apart

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md).

Spec §5.1 times PS-1 from `CreateDeployment` to the first served request
through the edge, and spec §3.3 step 4 names that request a `report`, a call
to the agent. Two things stand in the way. At the time a tenant is ACTIVE, the
agent path may not be open: the first tenant builds the cell before the
front door's phase two sets `agentIngress`, so `/agents/*` is refused until
then (spec §3.5). And an agent call costs a model call, which PS-1 would pay for
every tenant before the load scenarios.

## Options considered
### Option 1: The first served `report`
Pros: the path a tenant uses. Cons: it needs the ingress open, a request body
the control-plane slice does not know (it is the runtime-isolation slice's
protocol), and a model call per tenant.

### Option 2: The first served `GET /api/whoami`
The cell API origin answers it from the verified token and the route hint
(front-door spec §3.5). Pros: it crosses the edge, the router, the route table,
the origin access control and the cell API, the parts a new tenant needs the
control plane's routes to reach; it needs no model call; the answer carries the
tenant and the route hint, so it is an isolation assertion (spec §5.3). Cons:
it does not cross the ingress.

## Decision
Option 2. A tenant is ready when its first `/api/whoami` through the edge
returns its own tenant and its own route hint. Its identity tenant and users are
made first, as soon as its deployment is ACTIVE, so the identity calls are in
its time (stress ADR-0017). The agent path is the load scenarios' (PS-2 and
after). The warm-up tenant (spec §3.5 step 5) is timed apart as `warm-up-ready`:
its deployment includes the cell build, and its first `/api/whoami` waits for the
set-up that runs between the warm-up step and PS-1.

## Consequences
Easier: PS-1 is the same at every tier and costs no model calls.

Harder: PS-1 says nothing of the ingress; a defect there shows in PS-2. The
warm-up tenant's `warm-up-ready` is not an onboarding time: it holds the cell
build and the set-up between the warm-up step and PS-1 (front-door phase two,
the k6 host, the identity slice's PS-1), and PS-1's p50 and p99 leave it out.
The warm-up step logs the cell build itself: in the first platform run the
warm-up tenant was ACTIVE 759 s after `CreateDeployment`, the cell 617 s from
CREATING to ACTIVE, and `warm-up-ready` was 1,157 s. A tenant that was not placed in this run (a rerun) is timed
apart as `rerun-ready`: its clock would start at the old `CreateDeployment`.

The identity work starts at the next poll after ACTIVE (up to about ten seconds),
at most four tenants at a time, with the identity calls paced at four a second,
so in a wave `ready` includes that queue wait and grows with the wave. A large
tier's p99 is not the platform's onboarding time alone.

The end of the interval is the driver's clock, the start is the control plane's
`createdAt`. In W-9's first failed run, API Gateway counted 31 of the tenant-identity
slice's 40 PS-1 calls in that slice's one-minute window, which points to the driver's clock
running behind CloudWatch's by up to a minute (inferred from that count, not measured).
If so, `ready` is understated by that offset; at `small` (p50 about 166 s) a minute is about
36% of the value, so read `ready` as a lower bound. Measuring the offset once at the start of
PS-1 would remove the doubt.

Revisit if the first agent call after onboarding is slower than the rest in
PS-2, which would mean PS-1 hides an onboarding cost.

The first platform run at `small` (W-9, `stress/results/2026-11-21-small.md`)
timed PS-1 this way: 19 of 19 tenants placed, `ready` p50 165.9 s and p95 222.9 s.
