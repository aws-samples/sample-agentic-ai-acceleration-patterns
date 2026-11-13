<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0005: Route on the unverified claim and verify at the origin

- Status: Proposed (spike S-7)
- Date: 2026-11-13
- Deciders: Dave Roberts (PSA)

## Context

In `single` mode the router reads the tenant from the bearer token
(ADR-0001). The edge must route on it, and refuse requests with no token
or an unknown or suspended tenant before any origin (P-7). The cell's API
verifies the token (§1.3, §3.5). The question is where the signature is
checked, and how the origin learns which tenant the edge routed on so a
request can only be served by its own tenant's cell (P-4). A cell in a
tenant-owned account must not be able to serve another tenant's request,
even when a forged token reaches it.

## Options considered

### Option 1: Decode at the edge, verify at the origin, with a route hint

The router base64url-decodes the payload without checking the signature,
reads `tenant_id`, routes, and adds `x-tenant-route: <tenantId>` after
removing every client `x-tenant-*` header (§3.3 steps 1, 5, 7). For
`/api/*` it also copies the token into `x-tenant-token`, because origin
access control overwrites `Authorization` (ADR-0011). The origin verifies
the token, refuses a `tenant_id` that differs from the hint, and
refuses a tenant its cell does not host (§3.5).

Pros: the router stays a CloudFront Function with no secrets, no key
fetch and no network call (P-1). A forged claim only sends the request to
a cell that refuses it (P-1, §10 step 7). In `host` mode the hint carries
the host's tenant, so a token for `a` on `b`'s host is refused even when
both tenants share one cell (P-4). In `single` mode the hint comes from the
same token the cell verifies, so it always agrees; there the cell's check
that the tenant is one it hosts is what stops a forged claim. Cons: a forged token
costs one origin request before it is refused. Every cell API must
implement the hint and host checks (§6.1).

### Option 2: Verify at the edge with Lambda@Edge

A Lambda@Edge function fetches the issuer's keys and checks the signature
before routing.

Pros: forged tokens never reach an origin. Cons: key fetching and caching
at the edge, higher latency and cost per request, and a second function on
the path. The origin must still verify, since it cannot trust that the
edge did, so the work runs twice.

### Option 3: Decode at the edge, verify at the origin, no hint

As Option 1, without `x-tenant-route`.

Pros: one header fewer. Cons: in `host` mode the origin cannot tell that
the edge routed on a different tenant from the one the token names. A cell
hosting both `a` and `b` would serve a token for `a` sent to `b`'s host,
which P-4 rules out.

## Decision

Option 1, pending S-7. The edge reads the claim only to choose a route and
grants nothing (P-1); the origin is the authoriser and checks the verified
claim against the hint and its own tenants (P-4). This keeps the router
small and keyless, still refuses unknown and suspended tenants at the edge
(P-7), and needs no signature check twice. Option 2 duplicates
verification at higher cost; Option 3 loses the agreement check.

## Consequences

- Easier: the router holds no keys and needs no issuer access; the same
  hint and check work in `host` mode, where the host decides the tenant.
- Easier: refusals at the origin are logged with both tenant ids (§3.5).
- Harder: every cell API must verify the token, compare `tenant_id` with
  `x-tenant-route`, and check its own tenant namespace; the demo cell API
  is the reference (§6.1).
- Harder: forged tokens reach an origin and cost a refusal there.
- Follow-up: the threat model records the forged-claim path and the client
  `x-tenant-route` path (§10 steps 7 and 8).
- Spike: S-7 must read `tenant_id` from a real `tenant-identity` access
  token in a CloudFront Function, with compute utilisation under 50 %, and
  return 401 on a malformed token. It reports deploy and destroy time.
- If S-7 fails: `host` becomes the default addressing mode, which needs no
  decode, and a new record supersedes ADR-0001. Moving the decode to
  Lambda@Edge is no fallback: KeyValueStore is readable only from
  CloudFront Functions, and one behaviour cannot run both on viewer
  request, so it would reopen ADR-0003 and ADR-0004.
- Revisit when the origin cannot verify tokens, or when forged-token load
  on origins becomes a cost problem.
