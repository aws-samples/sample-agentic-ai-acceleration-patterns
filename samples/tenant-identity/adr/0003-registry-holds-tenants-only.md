# ADR-0003: Keep a tenant registry in DynamoDB, and make Cognito the only user store

- Status: Accepted
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The sample needs to know which tenants exist and, for `pool-per-tenant`,
which pool belongs to which tenant. It also needs to reject tokens for
offboarded tenants (P-2). Cognito holds users, groups, and attributes but has
no tenant entity, no `iss`-to-tenant lookup, and no status flag on a group.

## Options considered
### Option 1: No table; derive everything from Cognito
Pros: one system. Cons: `pool-per-tenant` needs a reverse lookup from issuer
to tenant, which means `ListUserPools` and tag reads on the request path; no
`DELETING` state during a partial offboarding; group description as tenant
name is a convention with no schema.
### Option 2: DynamoDB table with tenants AND users/memberships
Pros: fast user listing; one place to query. Cons: two sources of truth for
users; every Cognito change must be mirrored; drift is inevitable and the
mirror becomes what the application trusts (P-5 forbids this).
### Option 3: DynamoDB table with tenants only; users and memberships live in Cognito
Pros: the registry answers the two questions Cognito cannot (which tenants
exist and what status they have; which pool is which tenant) and nothing
else; the `DELETING` flip before Cognito clean-up gives offboarding a
guaranteed rejection within one cache TTL (R-9). Cons: listing a tenant's
users is a Cognito call, slow and paginated.

## Decision
Option 3. One single-table registry (`PK=TENANT#<id>`, `SK=META`), a
`byIssuer` GSI used only by `pool-per-tenant`, point-in-time recovery on.
No user, membership, credential, or token material is ever written (R-8).

## Consequences
Easier: offboarding has a clear two-phase shape (flip status, clean Cognito,
remove item) and a retry path; the resolver's status check is a cheap cached
read. Harder: operator-facing user listing is Cognito-paced; acceptable for a
platform API. Revisit if a consumer needs per-user metadata Cognito cannot
hold (attribute count or size limits); that is a new entity with its own
ADR, still not a mirror of the directory.
