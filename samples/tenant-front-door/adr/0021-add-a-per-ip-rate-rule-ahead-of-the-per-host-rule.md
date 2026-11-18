<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0021: Add a per-IP rate rule ahead of the per-host rule

- Status: Accepted
- Date: 2026-11-18
- Amends: ADR-0009
- Deciders: Dave Roberts (PSA)

## Context

ADR-0009 limits each tenant in `host` mode with an AWS WAF rate-based
rule keyed on the `Host` header and scoped down to `/api/*` and
`/agents/*`, at `tenantRequestsPer5Min` (default 2,000). WAF evaluates a
request before the viewer-request function runs, so the rule counts
every request in its scope-down, including the ones the router then
refuses with 401 for having no token or 403 for a token of another
tenant. An anonymous client that sends tokenless requests to
`b.<appDomain>/api/*` therefore takes `b`'s count to its limit, and
`b`'s own users get 429. The full design review found this gap.

`single` mode does not have it. It has no edge rate rule; the origin
counts verified requests only, so a tokenless or forged request is
refused by the router (401) or the cell before any count (ADR-0009).

Constraints: the rule must stay at the edge (P-7), keep each tenant's
count separate (spike S-6), and add no code to the router.

## Options considered

### Option 1: No per-IP rule

Keep ADR-0009 as it is. Pros: nothing to build, and no limit that
users who share one address can hit. Cons: any one client can lock a
tenant's users out of `/api/*` and `/agents/*` for as long as it keeps
sending, with no token.

### Option 2: An IP-only rate rule

A second rate-based rule keyed on the client IP alone, ahead of the
per-host rule. Pros: WAF's simplest key, and its managed-keys call can
list the blocked addresses. Cons: one count per address across every
tenant host, so a client that legitimately uses several tenants, or an
integration that serves many, spends one budget across all of them;
the limit then has to be set for the busiest such client.

### Option 3: A rule aggregated on `Host` and client IP

A second rate-based rule with a custom key of the `Host` header and the
client IP, the same scope-down and the same custom 429, ahead of the
per-host rule (a lower priority number). Pros: one address gets one
count on each tenant host, so it cannot push a host's count past its own
limit, and it does not spend its budget on one tenant by using another.
A request this rule blocks ends the evaluation and never reaches the
per-host count. Cons: a flood from many addresses still counts against
the host; one limit applies to every host; and the managed-keys call
lists keys only for an IP aggregate, not for this custom key, so blocks
are seen through metrics and sampled requests.

## Decision

Option 3. In `host` mode the web ACL carries a rate-based rule
aggregated on `Host` and client IP, scoped down to `/api/*` and
`/agents/*`, with the custom 429, at `ipRequestsPer5Min`, ahead of the
per-host rule. The default is 500 requests in 5 minutes. It is a chosen
value, not a measured one: a quarter of the default
`tenantRequestsPer5Min`, so four addresses are needed to use up a
tenant's budget, and well above what one interactive user sends.
Option 1 leaves the lock-out open; Option 2 charges a multi-tenant
client once for all tenants. `single` mode gets no edge rule, because
its origin limit already counts verified requests only.

## Consequences

- Easier: one address can no longer use up a tenant's budget, with or
  without a token.
- Harder: `ipRequestsPer5Min` is one value for every tenant host. A
  tenant whose users all reach the edge through one office NAT address
  shares one count: at 500 that is about 1.7 requests per second for the
  whole tenant before `tenantRequestsPer5Min` applies. The deployer
  raises it for such a tenant, and the raise applies to every host.
  Keep it below `tenantRequestsPer5Min`, or the per-host rule never
  binds first for one address.
- Harder: a flood from many addresses can still bring a tenant's host to
  its limit (spec §6.2 limits).
- Known limitations: the rule's block is not driven end to end. The
  integration test sends from one address, so it raises
  `ipRequestsPer5Min` above `tenantRequestsPer5Min` with a stack update
  for the per-host step and checks the rule's priority and key in the
  web ACL template test (spec §10).
- Revisit when a measured traffic profile gives a better default, or
  when WAF can key on a value derived from the token, which would let
  the per-host rule count only verified requests.
