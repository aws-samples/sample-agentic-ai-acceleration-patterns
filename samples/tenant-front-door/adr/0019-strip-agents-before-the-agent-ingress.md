<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0019: Strip `/agents` before the agent ingress

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0011
- Deciders: Dave Roberts (PSA)

## Context

The SPA calls an agent at `/agents/<backend>/invocations` on the app's
own origin (spec §3.2). The `/agents/*` behaviour sends it to the single
`agentIngress` origin, whose origin path is the ingress's stage
(`/prod`, the path of the `baseUrl` that `agentic-runtime-isolation`
publishes, spec §6.3). CloudFront appends the request path to the origin
path as it is, so without a change the ingress receives
`/prod/agents/<backend>/invocations`. The `api-gateway` ingress routes
`POST /{backend}/invocations` under its stage, with no `/agents`
prefix (`src/shared-ingress.cdk.ts`), and answers that path with 403.
The S-5 spike build found the mismatch; its first stand-in hid it with
an `/agents/{proxy+}` resource.

The same REST API also serves routes the front door must not expose:
the bare `/invocations` default-backend route, `/<backend>/delegations`
(agent-to-agent, ADR-0048 of that sample), the token issuer's
`/.well-known/*` routes and `/entitlements/*`.

## Options considered

### Option 1: The router strips `/agents` (viewer-request `uri` rewrite)

On the `/agents/*` behaviour the tenant router rewrites `request.uri`
from `/agents/<backend>/invocations` to `/<backend>/invocations`, and
answers 404 for any other `/agents` path. Pros: a change in this sample
only, none in the consumed sample; one string operation in a function
that already runs on the request. CloudFront picks the cache behaviour,
and with it the origin, from the viewer's path before the function
runs, and a changed `uri` changes neither (CloudFront Functions event
structure, `uri`:
<https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html>),
so the rewritten request stays on `/agents/*` and its policies. `uri`
holds no query string, so the query goes on unchanged. The router's
pattern also limits what the front door forwards to the one agent
route. Cons: the edge holds a copy of the ingress's route shape and
backend-name pattern; if the ingress adds a route the SPA must reach,
the router changes too.

### Option 2: An `/agents` base path on the ingress side

Either `agentic-runtime-isolation` adds an `/agents` resource above
`{backend}`, or the deployer fronts its stage with an API Gateway custom
domain and an `agents` base path mapping. Pros: the edge forwards the
path untouched. Cons: the first changes the consumed sample's published
route (`<baseUrl>/<backend>/invocations`) for every other caller; the
second needs a custom domain, a certificate in the ingress's Region and
a DNS record per ingress, all deployer-supplied, for a prefix only the
front door wants. Neither limits which ingress routes the front door
exposes.

### Option 3: Serve agents at `/<backend>/invocations` on the app's origin

No prefix at all. Cons: the agent route then shares the path space with
the SPA's routes and needs a cache behaviour per backend name, or a
catch-all behaviour that takes SPA routes too.

## Decision

Option 1. It is a change to this sample alone, it keeps the consumed
sample's published interface as it is, and the documented CloudFront
order (behaviour chosen on the viewer's path, then the function) means
the rewrite cannot move a request to another behaviour or origin. The
router forwards a path only when it matches
`^/agents/[a-z0-9-]{1,32}/invocations$` (the ingress's backend-name
pattern), so `/agents/<backend>/invocations` reaches the ingress as
`<originPath>/<backend>/invocations`; `/agents`, `/agents/` and every
other `/agents` path get 404 at the edge.

## Consequences

- Easier: the consumed sample's routes and published `baseUrl` stay as
  they are, and the front door exposes one ingress route, not the
  issuer, entitlement or delegation routes behind the same API.
- `/agents` without a slash falls under the default (SPA) behaviour, so
  the router checks it before it rewrites SPA routes to `/index.html`
  (spec §3.3 step 3). The default behaviour allows only `GET` and `HEAD`, so a
  `POST /agents` gets CloudFront's own 403 before the router runs; either
  answer keeps it from the ingress (S-5).
- The real ingress serves `POST` only. A `GET` to an agent route passes
  the edge and gets the ingress's own 403. S-5's `GET` check therefore
  proves that the origin request policy forwards `Authorization` on
  `GET`, not a route.
- Spike S-5 passed on 2026-11-18, on a standard distribution: the
  ingress saw `<stage>/<backend>/invocations` with no `/agents`,
  streams arrived unbuffered, and `/agents/` got the router's 404
  (spec §9). The `tenant-only` distribution the front door deploys is
  verified by spec §10 step 23, with the rewrite, every 404 case and
  one streamed `POST` to a stand-in ingress.
- Harder: a new ingress route the SPA must call (a bare default-backend
  route, say) needs a router change and a spec line.
- Revisit when `agentic-runtime-isolation` changes its route shape or
  backend-name pattern, or when the `agentcore-gateway` ingress kind is
  put behind `/agents/*` and its URL form differs from
  `<baseUrl>/<backend>/invocations`.

Note 2026-11-23: `src/shared-ingress.cdk.ts` in the Context is a file of
the `agentic-runtime-isolation` sample, not of this one.
