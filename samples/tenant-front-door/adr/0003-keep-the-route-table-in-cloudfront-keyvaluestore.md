<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0003: Keep the route table in CloudFront KeyValueStore

- Status: Accepted
- Date: 2026-11-13
- Amended by: ADR-0017, ADR-0031
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
writes it with the store's ETag (`IfMatch`) and, on a conflict,
re-reads, re-checks and retries (§3.4 step 5).

Pros: reads run inside CloudFront Functions at the edge, with no network
call and no origin. A write applies without a function publish or a
distribution change (P-9). The store has one writer, the registrar, so
P-3 holds through IAM. Cons: one store holds 5 MB and each value 1 KB,
so the tenant count has a ceiling (§4.1, ADR-0012). A write takes time
to reach every edge location (S-2). Writes are serialised through the
ETag.

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

Option 1; spikes S-1 and S-2 ran on 2026-11-16. KeyValueStore is read
inside the router at the edge with no network call, so refusals for
unknown and suspended tenants cost no origin capacity (P-7). It changes
without a publish or a distribution update, so onboarding stays one
registrar call (P-9), and the registrar is its only writer (P-3). Option
2 adds a network call to every request; Option 3 breaks P-9.

## Consequences

- Easier: suspend and resume are one key write (§4.2); removal is a delete.
- Easier: the router stays a pure lookup with no writes. It holds no secrets
  in `single` mode; in `host` mode it holds one, the sign-in HMAC key, in
  the `signin` entry (ADR-0016).
- Harder: the tenant count per front door is bounded by the store size
  (ADR-0012).
- Harder: a route is not live everywhere at once. Scripts and the
  integration test must allow for the propagation time S-2 measures.
- Harder: values keep a version field (`v`) and stay small; the router
  never reads `ac` (§4.1).
- Spike S-1: the store is readable from a viewer-request function on a
  multi-tenant distribution (ADR-0002).
- Spike S-2 (100 rounds, one edge location): a write takes a median of
  28.4 s and a p99 of 29.4 s from `put-key` to the first routed request,
  for inserts and updates alike, with no timeouts. That is fine for
  onboarding but not instant. `route.sh` bounds its wait at 45 s after
  the registrar returns (S-2 max 29.5 s at one edge location, plus
  margin). For cell routes and in `single` mode it waits the full 45 s,
  a bound and not a check: a route in `single` mode cannot be observed
  without a tenant token, and a `cell#` route cannot be observed from
  outside at all. In `host` mode `put-tenant` polls
  `https://<tenant>.<appDomain>/config.json` and returns on the first
  200, and `delete-tenant` on the first 404; past 45 s it warns and
  exits 0, because the write has succeeded (spec §4.2). There is no
  unauthenticated probe path, because one would reveal whether a tenant
  id exists. The integration test waits 60 s only after a change it
  makes without `route.sh` (spec §10).
- Harder: `suspended` and a delete take effect after the same window. A
  suspended or removed tenant is still routed until the change reaches the
  edge location, and the cell's hosts check is the only refusal in
  between.
- Revisit when the tenant count nears the store ceiling, or when the
  router needs more than three reads per request.

Note 2026-11-18, effective when ADR-0017 (Proposed) is accepted:
`route.sh` goes. The route hook, which the control plane will run on
cell and deployment events, waits the same 45 s bound, polls the same
way in `host` mode, and warns and exits 0 past it, so a cell or
deployment reaches `ACTIVE` once its route is live. The integration test
waits 60 s only after a change it makes without the hook.

Note 2026-11-19: the smoke run (design/spikes.md) saw requests miss a
change up to about 60 s after the write, after the first routed request.
The integration test waits 90 s after a change it makes without the hook
(spec §4.2, §10), where this record says 60 s.

Note 2026-11-20: ADR-0017 is accepted, so the 2026-11-18 note above is in
effect.

Note 2026-11-23: ADR-0031 amends this record. A writer treats a stale
`IfMatch` as a conflict whether the store answers `ConflictException`,
HTTP 409 or 412, or a `ValidationException` whose message says the
pre-condition failed, and retries it as this record's ETag rule says.
