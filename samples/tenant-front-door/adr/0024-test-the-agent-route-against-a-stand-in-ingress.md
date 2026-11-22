<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0024: Test the agent route against a stand-in ingress

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)

## Context
The `/agents/*` route sends a tenant's agent calls to the agent ingress of
`agentic-runtime-isolation` when `agentIngress` is set (spec §3.1, §6.3).
What the front door owns on that route is the router's path filter and
rewrite (ADR-0019), its refusals of unknown and suspended tenants, and a
response that streams through CloudFront unbuffered (spike S-5). The
ingress verifies the token and picks the tenant itself (spec §3.5).

The integration test (spec §10 step 23) needs an origin behind the route.
Spec §11 left open whether that origin is the real ingress (Q-4).

## Options considered
### Option 1: Compose `agentic-runtime-isolation`
Deploy that sample, or reuse a deployment when its published parameter is
found, and send step 23 to its real ingress. Pros: the real ingress is
behind the filter, so its own routes (`/invocations`,
`/<backend>/delegations`, `/.well-known/*`, `/entitlements/*`) are probed
through the edge. Cons: a second sample's stacks, quotas and tenants in the
test, a long deploy, and a run that fails for reasons in the other sample.
Reusing a found deployment makes the test depend on what the account
happens to hold.
### Option 2: The stand-in of spike S-5
A REST API with a REQUEST authoriser and a streaming Lambda proxy that
records what reaches it. Pros: deploys in about a minute (67 s in
S-5); asserts exactly what
the front door owns: the rewritten path `<stage>/<backend>/invocations`,
the forwarded bearer and `x-tenant-route`, and unbuffered streaming; and
records that a refused path never reaches it. Cons: the real ingress's
routes are not exercised behind the edge.

## Decision
Option 2. The test checks what the front door is responsible for, and
the stand-in records it more precisely than the real ingress would. The
path filter refuses every path that is not `/agents/<backend>/invocations`
before any request leaves the edge (ADR-0019), so only that shape reaches
the ingress. Which of the ingress's resources it lands on is the
ingress's decision: a backend name equal to one of its static top-level
resources (`entitlements`, `invocations`) resolves into that resource's
tree, not `{backend}`, and as of this record answers 403 there. The
stand-in cannot show that, and `agentic-runtime-isolation`'s own test is
what covers its resource tree.

## Consequences
- §10 step 23 runs against the stand-in; §11 no longer lists Q-4.
- Threat model T-16 stays mitigated by the path filter, with the residual
  that the real ingress is not driven through the edge in this sample's
  test.
- Step 23 also tests `/agents/entitlements/invocations` on the router,
  which shows that the router forwards a static-resource name, and
  checks a suspended tenant's 503 on the route (two 90 s propagation
  waits).
- A deployer who puts an `agentcore-gateway` ingress behind `/agents/*`
  runs step 23's assertions against it, after checking its URL form
  (ADR-0019).
- A new `entitlements/invocations` or `invocations/invocations` resource
  in `agentic-runtime-isolation` would be reachable through the edge; that
  is the "route shape" change ADR-0019 names as its revisit trigger.
- Revisit if the front door takes on a check that only the real ingress
  can answer, for example an ingress-side refusal the edge relies on.
