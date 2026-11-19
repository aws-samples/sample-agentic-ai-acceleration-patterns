<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0006: Generate `/config.json` at the edge

- Status: Accepted
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

The SPA needs its public settings before it can sign a tenant user in: the
issuer's authorize and token endpoints, the client id and the scopes; it
does not fetch the issuer's discovery document (spec §7.1). In `host`
mode it also needs the tenant id and display name for the host it was
loaded from (ADR-0001), and the shared sign-in `redirectUri`,
`https://login.<appDomain>/callback` (ADR-0016). On a dedicated domain
it needs `signInHost`, the host where its users sign in (ADR-0016):
`<tenant>.<appDomain>` in `host` mode, `<appDomain>` in `single` mode.
None of these values is secret.

The SPA is one build for every tenant, served from one S3 bucket, with
content-hashed assets cached for a year (spec §3.2, §7.2). Onboarding a
pooled tenant must be one registrar call, with no distribution update and no
cache invalidation (P-9). The route table already holds the shared settings
in its `app` key and each tenant's display name in its `tenant#` key
(spec §4.1, ADR-0003). In `single` mode the SPA learns the tenant after
sign-in, from its own token, so on `<appDomain>` the file holds only the
shared settings.

## Options considered

### Option 1: Generate the file in the tenant router

The router answers `/config.json` itself (spec §3.3 step 8). It builds the
body from the `app` key, and in `host` mode from the `host#` and `tenant#`
keys it already read to route. On a dedicated domain it derives
`signInHost` with no extra read: from the tenant id the `host#` entry
gave it in `host` mode, from the compiled `appDomain` in `single` mode.
The response is `no-store`.

Pros: one SPA bundle for every tenant. A new tenant's settings exist the
moment its route is written, so P-9 holds. No origin request and no extra
storage. The router stays within its three key reads per request.
Cons: the router grows a second job besides routing. The file can carry only
what fits in the route table's 1 KB values.

### Option 2: One file per tenant in S3

The tenant create script writes `config/<tenantId>.json` to the SPA bucket,
and the router rewrites `/config.json` to it.

Pros: the router only rewrites a path. Cons: a second writer and a second
store for tenant data, beside the route table (P-3). Every onboarding and
removal touches the bucket, and a cached copy outlives a removed tenant
unless it is invalidated, which breaks P-9.

### Option 3: Build the SPA per tenant

Each tenant gets its own build with its settings compiled in.

Pros: no runtime lookup at all. Cons: one build and one upload per tenant,
assets no longer shared across tenants, and a tenant cannot go live without
a build. It works against the one-bundle model of spec §3.2 and against P-9.

## Decision

Option 1. The tenant router generates `/config.json` from the route table
and returns it with `no-store`. This keeps one SPA bundle for every tenant,
keeps the route table the only tenant data at the edge (P-3), and makes a
tenant's settings live with its route, with no distribution change and no
invalidation (P-9). In `single` mode the file needs no tenant; in `host` mode
it needs the host to resolve to a live tenant, as any other tenant path does.

## Consequences

- Easier: onboarding and removal touch one store. The SPA has one load
  path in both addressing modes.
- Easier: an unknown host gets 404 and a suspended tenant gets 503 on
  `/config.json` too, so the SPA never starts for a tenant that is not live.
- Harder: the file is limited to values the router can read from the route
  table. A setting that is large or per user does not belong here.
- Harder: the router code owns a response body, so its unit tests cover
  both modes and the missing-key cases.
- Follow-up: the front door stack writes the `app` key on deploy. Changing
  the issuer or client means a stack update, not an SPA build.
- Revisit when per-tenant SPA versions or staged rollouts arrive (spec §1.2),
  or when the SPA needs settings that do not fit the route table.
