# ADR-0048: Measure tenant churn through the front door's edge

- Status: Accepted
- Date: 2026-11-21
- Deciders: Dave Roberts (SA)

## Context
The platform stress test (`docs/stress-test.spec.md` §5.1, PS-5) churns
tenants while the platform carries load. It times how long a created,
suspended, resumed or deleted deployment takes to show at the edge, and it
asserts that a removed or suspended tenant is never served. This slice owns
PS-5. The edge is the front door's, deployed by another slice; the slice reads
its address from `tenant-front-door.json` (`stress/README.md`, "Platform mode:
manifests"). Four choices were not obvious.

1. **What to read.** How to learn what the edge does for one tenant now.
2. **How to tell the router's answer from the origin's.** Both refuse with a
   403.
3. **How to change a route's status.** `UpdateTenantRouteStatus` belongs to the
   front door's registrar, whose access policy allows its edge operator role.
4. **How many cycles at once.** Each cycle starts a tenant build.

## Options considered
### Option 1: Probe the edge with a token that names the tenant and carries no signature
The router reads the tenant from the token's payload without checking the
signature (front-door spec §3.3, step 5), answers from its route table, and
passes the request on only when the route is live. The origin's ingress then
refuses the token, so no agent call runs and nothing is spent. Pros: no
credential, no cost, and the answer is the edge's own. Cons: it shows what the
router does for the tenant, not what a signed request would get; it relies on
the router not verifying signatures.

### Option 2: Probe with a signed token from the stress identity
Pros: the request is a real one. Cons: each probe reaches the cell's ingress
and an agent, so polling every two seconds costs model calls and loads the
platform it measures; the slice then depends on the identity tenant and users
of every churn tenant, which a platform run does not create.

### Option 3: Read the route table directly
Pros: exact, no polling. Cons: it measures the store, not the edge, and the
question PS-5 asks is when a change reaches a viewer.

## Decision
Option 1. It costs no model call and needs no identity users; Option 2 loads
the platform it measures, and Option 3 does not measure the edge.

- **Reading.** `test/stress/edge.ts` sends one `POST /agents/<backend>/invocations`
  per read. The router writes its refusals as `{"status":<code>}`: a 403 is no
  route entry, a 503 is a suspended tenant. The `api-gateway` ingress refuses
  the unsigned token with 403 and the body `forbidden`, so the probe reads the
  body as well as the status. An answer counts as the origin's, and the tenant
  as routed, only when API Gateway's request id (`x-amzn-requestid`) is on it.
  `x-cache` cannot tell the two apart, because CloudFront sets
  `Error from cloudfront` on an origin's 4xx too. No answer, a 404, and an
  answer with neither the router's body nor the request id (CloudFront's own: a
  geographic restriction, a function failure) tell nothing about the tenant and
  are read again.
- **Registrar.** `setStatus` signs the call with the caller's own credentials
  through `curl --aws-sigv4`, passing the key pair on stdin and never in the
  arguments. The session that runs PS-5 holds the edge operator role. The
  alternative, a signing library in the driver, adds a dependency for one call.
- **Settling.** A refused tenant is read again after 90 s (the front door's
  propagation wait, front-door spec §4.2), three times, and each read is an
  isolation assertion.
- **Concurrency.** The cycles run at most as many at once as the control
  plane's concurrent build limit (stress ADR-0013), which is also the draw PS-5
  records on the platform account's builds. Unbounded cycles would exceed it
  and fail on throttled builds.
- **Counting.** The record's `requests` holds the edge's and the registrar's
  answers under `edge:<status>` and `registrar:<status>`, so `collect` weighs
  only the control plane's own 5xx against its access log (P-7). A suspended
  tenant answers 503 on every poll, and those answers would hide a 5xx the
  driver did not see.
- **Churn.** A cycle creates and deletes the tenant's deployment, and suspends
  and resumes its route. The tenant record is the one `seed` made.

## Consequences
Easier: PS-5 costs no model call, needs no identity users, and measures the
time a viewer waits.

Harder: the probe fits a front door in `single` addressing mode whose host is
its `appDomain` and whose tenant claim is `tenant_id`; another front door
answers 404, 403 or 401 whatever a tenant's state, and PS-5 stops with that
cause. A change to the router's refusal bodies or its signature check breaks
the reading, and `test/stress/churn.test.ts` guards the token pattern and the
refusal body by reading them from the router's own source. The router's
signature check has no such test. An ingress that answers without API
Gateway's request id would read as no answer, and the run would report the
tenant never routable.

Revisit when: the front door checks signatures at the edge, or its refusals
change shape, or the platform run creates the identity users and a signed read
becomes affordable.
