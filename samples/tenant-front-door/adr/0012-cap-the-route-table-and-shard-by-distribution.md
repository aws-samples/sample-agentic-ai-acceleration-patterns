<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0012: Cap the route table and shard by distribution

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

The route table is a CloudFront KeyValueStore (ADR-0003). A store holds at
most 5 MB, a key is at most 512 bytes, a value at most 1 KB, and a function
has one store. The tenant router is one function on the distribution, so
one front door has one store.

Sizes from §4.1: a tenant needs about 130 bytes in `single` mode (its
`tenant#` entry) and about 180 bytes in `host` mode (plus its `host#`
entry). `cell#` entries and the one `app` entry are few and small. One store
therefore holds about 25,000 to 40,000 tenants, depending on mode and on
display name length. Values carry a version field (`"v":1`), so their shape
can change without a key change.

The vendor needs to know where that limit sits and what happens past it,
before a tenant create script hits a full store.

## Options considered

### Option 1: One store with a stated ceiling

Pros: one function, one store, at most three reads per request (§3.3); one
writer (the registrar); nothing to choose per tenant. Cons: a hard ceiling
per front door.

### Option 2: Shard by distribution

Several distributions, each with its own router and store, and the
registrar choosing a shard per tenant. Pros: no ceiling. Cons: each shard
needs its own pooled distribution tenant and, in `single` mode, its own
domain, because one domain reaches one distribution; the SPA and the
issuer must learn which domain a tenant uses; a second assignment record
outside the control plane (P-6).

## Decision

Option 1, with Option 2 as the plan past the ceiling. One front door uses
one store and states a ceiling of 25,000 tenants in `host` mode and 40,000
in `single` mode, with the registrar refusing a write that would exceed
the store size. Past the ceiling the plan is another distribution and
another store; the sample does not build it, because the shard assignment
and the domain per shard are application choices that need their own
record.

## Consequences

- Routing stays one function and one store, so the request path has no
  shard lookup.
- Display names are kept short: `n` is the largest field in a tenant entry
  and drives the per-tenant size.
- The registrar returns a clear error when the store is full, and the
  README states the ceiling per mode.
- One front door per application (ADR-0014) means the ceiling is per
  application, not per vendor.
- Follow-up: a store-size metric and an alarm at 80 % of 5 MB, so the
  vendor plans a shard before a create fails.
- Revisit when an application expects more than about 25,000 tenants in
  `host` mode or 40,000 in `single` mode, or when CloudFront raises the
  store size or allows more than one store per function.
