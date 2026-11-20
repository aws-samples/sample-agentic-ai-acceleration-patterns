<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0016: Send agent traffic to the one cell's ingress at `small`

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md);
"front-door spec" and "front-door ADR" mean
[`samples/tenant-front-door/design/tenant-front-door.spec.md`](../../samples/tenant-front-door/design/tenant-front-door.spec.md)
and the records in
[`samples/tenant-front-door/adr/`](../../samples/tenant-front-door/adr/).

The platform run sends every prompt through the front door (spec §3.3,
§5.1). The front door routes two paths to dynamic origins, and they work
differently:

| Path | Origin | Chosen by |
|---|---|---|
| `/api/*` | the tenant's cell API, a Lambda function URL behind origin access control | the router, per request, from the `cell#` entry (front-door spec §3.3 step 7, front-door ADR-0004, front-door ADR-0011) |
| `/agents/*` | the one `agentIngress` input, an origin without origin access control | the deployer, once, at deploy (front-door spec §3.3 step 7, §3.6) |

The runtime-isolation ingress is a public API Gateway that verifies the
token itself (front-door spec §1.2). It is not a cell origin, and the
router cannot point `/agents/*` at a different ingress per cell. A path
of "router, then cell origin, then ingress" for agent calls, across
every cell, does not exist. The router adds `x-tenant-route` to the
request on both paths, but the ingress does not echo it, so an edge
check on the response's route hint has no source on `/agents/*`. The
real ingress has never been driven through the edge: the front door's
own test uses a stand-in (front-door ADR-0024).

The tiers fix the cell count (spec §4.1): `small` has one cell, `medium`
two, `large` four. The first platform run is at `small` (P-8).

## Options considered
### Option 1: A per-cell origin Lambda in front of each cell's ingress
Each stress cell adds a Lambda function URL behind origin access control
that forwards to its own ingress. Agent calls take the `/api/*`
mechanism, so the router picks the cell per request. Pros: works at
every tier with no front-door change; the origin can check the route hint
against the verified token and echo it, which gives §5.3 an edge check on
agent calls. Cons: an extra hop and its latency on every prompt; the
function must stream the response (response streaming on the function URL)
or PS-6 measures the Lambda, not the edge; a stress-only component in
every cell that the samples do not ship; one more Lambda draw on each cell
account's concurrency at the peak rate. Deploy: one function per cell,
added to the cell build (expected about a minute, on top of a cell build
of about 8 minutes, spec Q-1); no edge update.

### Option 2: A front-door change for per-cell agent origins
The front door gains a per-cell agent origin, for example an
`agentIngress` value in each `cell#` entry and an origin change in the
router for `/agents/*`, as it does for `/api/*`. Pros: no extra hop; the
platform composes the samples the way a vendor would, with no stress-only
part. Cons: a change to another sample's spec, router, registrar,
threat model and integration test, with its own review and spikes; an
origin set by `cf.updateRequestOrigin()` without origin access control
reaches a public endpoint, so the change needs its own decision on how
the route hint is checked; the platform run waits for it. Deploy: one
edge stack update per front-door release; no per-run edge update once
the route is in the KeyValueStore.

### Option 3: `small` only, with `agentIngress` set to the one cell's ingress
At `small` the one cell's ingress is the only agent origin, so the
existing `agentIngress` input serves it. Pros: no new component on the
agent path and no change in any sample; the first platform run can start
now. Cons: does
not work at `medium` or `large`; the front door is deployed in two
phases per run, because `agentIngress` is known only once the first cell
exists; the edge check of spec §5.3 on `/agents/*` is limited to what the
ingress shows. Deploy: the phase-two stack update that sets
`agentIngress` is a CloudFront distribution change in `us-east-1`,
not yet measured; the front door's spikes deployed their edge stacks in
221 to 506 s (front-door `design/spikes.md`).

## Decision
Option 3. The first platform run is at `small`, which has one cell, so
`agentIngress` is that cell's ingress and the edge sends `/agents/*`
straight to it. `/api/*` goes through the router's cell origin as the
front door specifies. The front door is deployed in two phases: the edge
first, then, once the first cell exists, `agentIngress` (spec §3.5). The
route hook (`registrarUrl` and the `RouteHookAccess` stack, front-door
ADR-0027) goes in with the first phase, so the first cell's route is
registered when the cell is built.

Per-cell agent routing for `medium` and `large` stays open as spec Q-7,
with Options 1 and 2 as its candidates. It is decided, by a new ADR that
amends this one, before the first `medium` run.

## Consequences
Easier: the first platform run needs no new component on the agent path
and no change to a sample; the edge-to-ingress hop is measured with
nothing between the two.

Harder: the run at `small` deploys the front door in two phases, and the
second is a CloudFront change whose time the run reports (P-6). The edge
check on `/agents/*` cannot read a route hint; spec §5.3 asserts the
token's tenant at the ingress and the vended credential instead. The
change that removes the limit is an ingress that echoes the hint it
received; Option 1 would bring it too. A `medium` or `large` platform
run cannot start until Q-7 is decided. A direct call to the ingress with
a valid token is served, by design (front-door spec §1.2), so PS-7
refuses only another tenant's token there.

Open points: the front door writes a tenant route only for a cell that
has a cell route, and the cell route needs the API domain from the cell
script's `frontDoorApiDomain` output; without it every deployment's
hook fails with 409 (front-door spec §3.2, §3.4). The stress cell script
does not yet emit it, and the stress cell serves no cell API origin, so
the first platform run adds a cell API origin and the output before any
tenant can be routed, on `/agents/*` as well as `/api/*`. Revisit when
Q-7 is decided, or if the front door gains per-cell agent origins.
