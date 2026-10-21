# ADR-0015: Make tenant admin a per-tenant group, and grant its scope only on narrowed tokens

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Tenant-admin user management (ADR-0014) needs a role: who is an admin of
which tenant. In `shared-pool-multi-tenant` one person can be an admin of
tenant A and a plain member of tenant B, so the role must be per tenant.
The role must be set only by an admin path (P-3), and it must reach the
token through the trigger, the only code that shapes tokens (ADR-0003).

## Options considered
### Option 1: A `roles` claim on every token
Pros: consumers read roles directly. Cons: in topology 3 a list of roles
needs a tenant per role, which grows the token and the contract (P-6); an
un-narrowed token would carry admin rights for every tenant the user
administers.
### Option 2: A mutable custom attribute per user
Pros: no groups. Cons: one value per user cannot say "admin of A, not of
B"; attributes are writable by the user unless excluded per client, a
second place to get P-3 wrong.
### Option 3: Group `admin-<tenantId>` in every topology; the trigger turns it into scope `tenant-admin/users` on narrowed tokens only
Pros: one naming rule in all three topologies; groups are admin-only by
construction; no new claim, only a scope; an admin token always names one
tenant, so admin rights for two tenants never ride in one token. Cons: two
groups per tenant (see ADR-0014 for the quota cost); an admin must exchange
before every admin call.

## Decision
Option 3. Membership in `admin-<tenantId>` makes `tenant-admin/users` a
scope the user holds for that tenant. The trigger never adds it to an
un-narrowed token. In a narrowed token it is added only when requested and
held for the requested tenant (the intersection rule of ADR-0010). Groups
matching neither `^t-` nor `^admin-` stay reserved for further roles (§11).

## Consequences
Easier: least privilege is structural: no token can carry admin rights
without naming exactly one tenant; the authoriser's check is one claim and
one scope (ADR-0007). Harder: the trigger reads two group prefixes; the
integration test must show that a non-admin's request for the scope is
refused (`invalid_scope`) and that an un-narrowed admin token is refused
by `/tenant/*`.
