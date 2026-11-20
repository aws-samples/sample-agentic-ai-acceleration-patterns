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
front door's own test runs the agent route against a stand-in ingress
(front-door ADR-0024), so the platform run is the first to drive the
real ingress through the edge.

The tiers fix the cell count (spec §4.1): `small` has one cell, `medium`
two, `large` four. The first platform run is at `small` (P-8).

## Options considered
### Option 1: A per-cell origin Lambda in front of each cell's ingress
Each stress cell adds a Lambda function URL behind origin access control
that forwards to its own ingress. The router sets a per-cell origin only
for `/api/*`, so agent calls are sent under `/api/*`, not
`/agents/<backend>/invocations`, and the router picks the cell per
request.

Pros: works at every tier with no router change; the origin can check
the route hint against the verified token and echo it, which gives spec
§5.3 an edge check on agent calls; the stress cell serves a cell API
origin in any case (below), which lowers the extra cost.

Cons: the client path differs from the one the front door specifies for
agents; the function maps the bearer back from `x-tenant-token` into
`Authorization`, because origin access control overwrites
`Authorization`; an extra hop and its latency on every prompt; the
function must stream the response (response streaming on the function
URL) or PS-6 measures the Lambda, not the edge; a stress-only component
in every cell that the samples do not ship; one more Lambda draw on each
cell account's concurrency at the peak rate.

Deploy: one more function per cell in the cell build, unmeasured, on top
of a cell build of about 8 minutes (spec Q-1); no edge update.

### Option 2: A front-door change for per-cell agent origins
The front door gains a per-cell agent origin, for example an
`agentIngress` value in each `cell#` entry and an origin change in the
router for `/agents/*`, as it does for `/api/*`.

Pros: no extra hop; the platform composes the samples the way a vendor
would, with no stress-only part.

Cons: a change to another sample's spec, router, registrar, threat model
and integration test, with its own review and spikes; an origin set by
`cf.updateRequestOrigin()` without origin access control reaches a
public endpoint, so the change needs its own decision on how the route
hint is checked; the platform run waits for it.

Deploy: one front-door main-stack update per front-door release, an
update of the existing distribution, unmeasured (the front door's spikes
took 221 to 506 s to create their distribution stacks, front-door
`design/spikes.md`); none per run, since each cell's agent origin is a
route-table write.

### Option 3: `small` only, with `agentIngress` set to the one cell's ingress
At `small` the one cell's ingress is the only agent origin, so the
existing `agentIngress` input serves it.

Pros: no new component on the agent path and no change in any sample.

Cons: does not work at `medium` or `large`; the front door is deployed
in two phases per run, because `agentIngress` is known only once the
first cell exists; the edge check of spec §5.3 on `/agents/*` is limited
to what the ingress shows.

Deploy: phase two is a front-door main-stack update that sets
`agentIngress`, an update of the existing distribution on every run,
unmeasured; the front door's spikes took 221 to 506 s to create their
distribution stacks (front-door `design/spikes.md`).

## Decision
Option 3. The first platform run is at `small`, which has one cell, so
`agentIngress` is that cell's ingress, and CloudFront sends `/agents/*`
to it once the router has set the hint and stripped `/agents`. `/api/*`
goes through the router's cell origin as the front door specifies. The
front door is deployed in two phases (spec §3.5). Phase one is two
deploys of the front-door app, the second with `registrarUrl`, which
adds the route hook (the `RouteHookAccess` stack, front-door ADR-0027),
so the first cell's route is registered when the cell is built. Phase
two, once the first cell exists, sets `agentIngress`.

Per-cell agent routing for `medium` and `large` stays open as spec Q-7,
with Options 1 and 2 as its candidates. It is decided, by a new ADR that
amends this one, before the first `medium` run.

## Consequences
Easier: the first platform run needs no new component on the agent path
and no change to a sample; the edge-to-ingress hop is measured with
nothing between the two.

Harder: the run at `small` deploys the front door in two phases, and the
second is a CloudFront change whose time the run reports (P-6). A
warm-up tenant builds the cell alone and waits for phase two, so PS-1
does not time it, and the cell account is registered with `maxCells` 1
at `small`, so a placement during the build is refused rather than
claiming a second cell (spec §3.5). The edge check on `/agents/*`
cannot read a route hint; spec §5.3 asserts the token's tenant at the
ingress and the vended credential instead, and sees an edge fault only
as a wrong admit or refusal. The change that removes the limit is an
ingress that echoes the hint it received; Option 1 would bring it too.
A `medium` or `large` platform run cannot start until Q-7 is decided. A
direct call to the ingress with a valid token is served, by design
(front-door spec §1.2), so PS-7 there refuses a token whose payload
names another tenant and serves the tenant's own.

The stress cell serves a cell API origin. The front door writes a tenant
route only for a cell that has a cell route, and the cell route needs the
API domain from the cell script's `frontDoorApiDomain` output; without it
every deployment's hook fails with 409 (front-door spec §3.2, §3.4). So
the cell script deploys a cell API origin with `CellRouteAccess`, which
takes the distribution ARN from a cell parameter, and writes that output
(spec §3.3 step 2, §3.5); a tenant is routed on `/agents/*` only once
this holds. Phase two reads the ingress's `baseUrl` from its published
parameter in the cell account (front-door spec §6.3) through a read-only
role that allows `ssm:GetParameter` on that one parameter (spec §3.6,
§3.7). The role adds one item to the account base that ADR-0006 lists.
Revisit when Q-7 is decided, or if the front door gains per-cell agent
origins.
