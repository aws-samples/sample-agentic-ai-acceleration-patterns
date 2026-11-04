<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0033: Let a tenant admin cut, never add, with sparse per-user rows

- Status: Accepted
- Date: 2026-11-02
- Amended by: ADR-0038
- Deciders: Dave Roberts (PSA)

## Context
A tenant admin must be able to take agents and tools away from a tenant user, and must never grant more than the tenant subscribed to (spec R-4). A tenant may have 100,000s of users, and most of them hold the tenant's full set. The vendor sets what a tenant subscribes to; the tenant admin works inside that.

## Options considered
### Option 1: A full grant row per user
Pros: the user's grant is one read and explicit. Cons: every change to a tenant's subscription rewrites every user row; a new user needs a write before first use; storage grows with users, not with decisions.

### Option 2: Sparse cut rows, absent meaning the full tenant set
A `TENANT#<id>` / `USER#<sub>` row lists the agents and tools the user keeps; no row means everything the tenant holds (ADR-0030). Pros: a user costs nothing until cut; a tenant subscription change needs one write; a cut is bounded by the tenant set by construction, because the grant is an intersection (ADR-0032). Cons: a missed read looks like "full", so a read error must fail the mint, never default to full.

### Option 3: Group-based cuts
Cuts per group, users mapped to groups. Pros: fewer rows for large tenants. Cons: a second membership store or a dependency on the identity provider's groups; a user in several groups needs a merge rule; more than the requirement asks.

## Decision
Option 2. The cut API lives on the ingress as a Smithy `restJson1` service. The tenant-admin side is authenticated with the tenant user's identity token, which must carry `entitlements/admin`; the tenant comes from the token's `tenant_id`, never from the path or body. The vendor side (tenant subscriptions and plans) is authenticated with IAM SigV4. A cut may name only an agent or tool the tenant holds; anything else is a 400.

## Consequences
Easier: adding back is deleting the cut; the common case, a user with the full set, needs no row and no write. A cut bumps `tenant.version`, so the next mint for that tenant sees it at once (ADR-0036). Harder: two authentication schemes on one API; the ingress must refuse a transaction token on the admin API (ADR-0031); a failed cut read must fail closed. Follow-up: the Smithy model, a test that a tenant admin cannot cut across tenants or add a tool the tenant lacks, and a threat-model entry for the admin scope. Revisit if tenants ask for group cuts (option 3) or for per-user additions beyond the tenant set, which this design forbids on purpose.

**Amended 2026-11-04.** Recorded from ADR-0038: when the identity token lists several tenants (`tenants`, `identity.multiTenant`), the tenant-admin operations take the tenant from `X-Tenant-Id`, which must name one entry the verified token lists; the tenant still never comes from the path or the body.
