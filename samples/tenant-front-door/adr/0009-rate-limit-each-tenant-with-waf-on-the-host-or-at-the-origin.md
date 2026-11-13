<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0009: Rate limit each tenant with WAF on the host, or at the origin

- Status: Proposed (spike S-6)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

One tenant must not use up the capacity that other tenants share: the edge,
the pooled cells and the agent ingress. The deployer sets one per-tenant
rate, `tenantRequestsPer5Min`, default 2,000 (spec §3.6). Bad traffic should
stop at the edge where it can (P-7).

The edge stack already holds a CloudFront-scope AWS WAF web ACL (spec §3.1,
ADR-0010). A WAF rate-based rule counts requests per aggregation key, and the
key can be a header value. WAF evaluates the request before the
viewer-request function runs, so it sees only what the viewer sent. What
identifies the tenant depends on the addressing mode (ADR-0001):

- In `host` mode the tenant is the `Host` header, which WAF reads as is.
- In `single` mode the tenant is the `tenant_id` claim inside the bearer
  token. WAF cannot decode the token payload, so it cannot key on the tenant.
  Keying on the whole `Authorization` header counts per token, not per
  tenant, and any client can send new header values. A header the router
  sets cannot be the key either, because the router runs after WAF.

## Options considered

### Option 1: WAF rate rule with a custom key

Key a rate-based rule on the `Host` header. Its Block action returns a
custom 429 response; WAF's default block answer is 403. A scope-down
statement limits the rule to `/api/*` and `/agents/*`, so SPA loads (`/`,
`/assets/*`, `/config.json`) do not count against the tenant.

Pros: over-limit requests get 429 at the edge (spec §5.3) and reach no
origin (P-7). No code in the router or the cell. Cons: only works in `host`
mode. Depends on WAF counting each host on its own, which S-6 tests.

### Option 2: Limit at the origin

The cell API, or the agent ingress, counts per verified `tenant_id` after it
checks the token (P-4).

Pros: keys on the tenant the cell verified, in either mode. Cons: over-limit
requests still cost edge and origin capacity. Every cell must implement it.

### Option 3: No per-tenant limit

Pros: nothing to build. Cons: one tenant can starve every other tenant on a
shared cell.

## Decision

Option 1 in `host` mode and Option 2 in `single` mode. In `host` mode the
web ACL carries a rate-based rule keyed on the `Host` header, scoped down to
`/api/*` and `/agents/*`, whose Block action returns a custom 429 response.
Each tenant host is counted alone and refused at the edge. In `single` mode
WAF cannot read the token's tenant, so the limit moves to the origin, which
counts on the verified `tenant_id`. The same `tenantRequestsPer5Min` value
drives both. This record stays Proposed until spike S-6 passes: tenant A
over its limit gets 429 while tenant B is served, and A's SPA loads are not
counted. If S-6 fails, `host` mode also limits at the origin, the 429 row in
spec §5.3 goes, and a new record supersedes this one.

## Consequences

- Easier: in `host` mode a noisy tenant is stopped before any origin.
- Easier: a dedicated distribution tenant can carry its own web ACL override
  with its own limit (spec §3.1).
- Harder: `single` mode gives up P-7 for rate limits. Over-limit traffic is
  refused only after it reaches the cell.
- Harder: in `host` mode a flood spread over many unknown hosts stays under
  each host's limit. The router refuses those with 404 at the edge
  (spec §3.3 step 2), so they reach no origin.
- Follow-up: add the per-tenant limit to the cell API contract (spec §6.1)
  and to the demo cell API. The agent ingress of `agentic-runtime-isolation`
  already limits each tenant (its ADR-0020).
- Revisit when S-6 reports, or when WAF can key on a value derived from the
  token payload.
