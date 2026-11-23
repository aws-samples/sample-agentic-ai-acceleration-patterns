<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0004: Route to cells with CloudFront Functions origin modification

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

The control plane places cells in vendor-owned and tenant-owned accounts,
and creates and removes them while the front door runs. Each `/api/*`
request must reach the API of its tenant's cell, in that cell's account
(§3.2). Adding a cell or a tenant must not change the distribution (P-9).
The cell API must be reachable only through the edge distribution; the
demo cell API is a Lambda function URL with origin access control, granted
by the `CellRouteAccess` construct in the cell's account (§3.1, §5.2).

## Options considered

### Option 1: Origin modification in the router

The router reads `cell#<cellId>` and calls `cf.updateRequestOrigin()` to
set the request's origin to the cell's API domain with origin access
control (§3.3 step 7). Origin access control overwrites `Authorization`, so
the same step copies the bearer token into `x-tenant-token` (ADR-0011).

Pros: one `/api/*` behaviour serves every cell. A new cell is a route table
entry, not a distribution change (P-9). The same router step finds the
tenant and picks the origin, so the route a request takes is the one the
table names (§6.2). Cons: the origin is chosen in code, so the distribution
shows no list of cells. Origin access control must sign for a function URL
in another account, which spike S-3 must show.

### Option 2: One origin and cache behaviour per cell

Each cell is a named origin with its own behaviour, selected by path or by
the router setting a path prefix.

Pros: plain CloudFront configuration, visible in the console. Cons: every
cell create and delete is a distribution update, which breaks P-9.
Behaviours and origins per distribution are bounded by quotas, so the cell
count is capped. A path prefix per cell leaks placement into URLs.

### Option 3: Lambda@Edge

A Lambda@Edge origin-request function looks up the cell and rewrites the
origin.

Pros: full Node.js runtime and network access. Cons: higher latency and
cost per request than CloudFront Functions. It needs its own route lookup
(see ADR-0003 Option 2), runs in many Regions, and adds a second function
to the request path.

## Decision

Option 1; spike S-3 passed on 2026-11-16. Origin modification lets one
behaviour reach every cell in every account, so a cell or tenant joins
with a route table write and no distribution change (P-9). It reuses the
router's own lookup in the KeyValueStore (ADR-0003), with no second
function. Option 2 breaks P-9 and caps the cell count; Option 3 adds
latency and a second lookup path.

## Consequences

- Easier: cells in any registered account are reachable through one
  `/api/*` behaviour; the registrar is the only place a cell joins (§3.4).
- Easier: a direct call to a cell's function URL, without CloudFront, is
  refused (§10 step 10).
- Harder: the cell list lives in the route table, so operators read it
  through the registrar or the store, not the distribution.
- Harder: each cell stack must include `CellRouteAccess`, conditioned on
  the distribution ARN, or the edge cannot invoke it (§6.1).
- Harder: only Lambda function URL and S3 origins are covered (§1.2).
- Spike S-3 (2026-11-16): `cf.updateRequestOrigin()` with an inline
  `originAccessControlConfig` (`originType: 'lambda'`, `signingBehavior:
  'always'`) signed requests to a function URL in a second account, even
  though the distribution's default origin had no origin access control.
  Results are in ADR-0011. Deploy 506 s, destroy 185 s.
- Revisit when origins other than function URLs and S3 are needed.
