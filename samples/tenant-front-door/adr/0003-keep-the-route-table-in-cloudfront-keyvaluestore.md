<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Keep the route table in CloudFront KeyValueStore

- Status: Proposed (spikes S-1 and S-2)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

On every request the tenant router needs three facts: the tenant behind a
host (`host#`), the tenant's cell and status (`tenant#`), and the cell's
API domain (`cell#`) (§4.1). It reads at most three keys and writes nothing
(§3.3). Unknown and suspended tenants must be refused before any origin
(P-7). Routes are vendor data written only by the route registrar (P-3,
§3.4). Adding or removing a pooled tenant must need no distribution update
and no cache invalidation (P-9).

## Options considered

### Option 1: CloudFront KeyValueStore

A KeyValueStore associated with the viewer-request function. The registrar
writes it with the store's ETag (`IfMatch`) and retries on a conflict
(§3.4 step 5).

Pros: reads run inside CloudFront Functions at the edge, with no network
call and no origin. A write applies without a function publish or a
distribution change (P-9). The store has one writer, the registrar, so
P-3 holds through IAM. Cons: one store holds 5 MB and each value 1 KB, so
about 25,000 to 40,000 tenants fit (§4.1); the ceiling and shard plan go in
a later ADR (§8 decision 12). A write takes time to reach every edge
location (S-2). Writes are serialised through the ETag.

### Option 2: Lambda@Edge plus DynamoDB

A Lambda@Edge function reads the route from a DynamoDB table, possibly a
global table.

Pros: no size ceiling in practice; rich queries. Cons: a network call per
uncached request, from edge Regions to the table's Regions, adds latency
and cost to every API request. Lambda@Edge runs in many Regions, which
spreads logs and complicates teardown. More code on the request path.

### Option 3: Routes in function code

The route map is a constant inside the CloudFront Function, republished on
each change.

Pros: no extra resource; fastest read. Cons: every tenant change is a
function publish, which breaks P-9. The function size limit caps the
tenant count far below Option 1. Routes live in deploy artefacts rather
than in data the registrar owns (P-3).

## Decision

Option 1, pending S-1 and S-2. KeyValueStore is read inside the router at
the edge with no network call, so refusals for unknown and suspended
tenants cost no origin capacity (P-7). It changes without a publish or a
distribution update, so onboarding stays one registrar call (P-9), and the
registrar is its only writer (P-3). Option 2 adds a network call to every
request; Option 3 breaks P-9.

## Consequences

- Easier: suspend and resume are one key write (§4.2); removal is a delete.
- Easier: the router stays a pure lookup with no secrets and no writes.
- Harder: the tenant count is bounded by the store size until the shard
  plan is decided (§8 decision 12).
- Harder: a route is not live everywhere at once. Scripts and the
  integration test must allow for the propagation time S-2 measures.
- Harder: values keep a version field (`v`) and stay small; the router
  never reads `ac` (§4.1).
- Spikes: S-1 must show the store is readable from a viewer-request
  function on a multi-tenant distribution (ADR-0002). S-2 must report the
  median and p99 time from write to first routed request. Both report
  deploy and destroy time.
- If S-1 fails: the store is still used, on the Option 2 distribution of
  ADR-0002. If S-2 shows propagation too slow for onboarding, `route.sh`
  waits until the route answers, and a new ADR records the wait.
- Revisit when the tenant count nears the store ceiling, or when the
  router needs more than three reads per request.
