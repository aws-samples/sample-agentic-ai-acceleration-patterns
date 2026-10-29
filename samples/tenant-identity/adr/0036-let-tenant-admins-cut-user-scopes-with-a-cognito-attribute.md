# ADR-0036: Let tenant admins cut a user's scopes with a Cognito attribute

- Status: Accepted
- Date: 2026-10-29
- Deciders: Dave Roberts (SA)

## Context
Within a tenant's entitlement (ADR-0035) the tenant admin wants to give some
users less: a read-only user for billing, a user with no billing at all. The
tenant admin already manages users through `/tenant/users` with the
`tenant-admin/users` scope (ADR-0014, ADR-0015). The reduction must be per
tenant: in topology 3 one person belongs to several tenants and may be cut
differently in each. Cognito is the only user store (ADR-0002), and the trigger
receives the user's attributes and groups in the event, so anything stored on
the user is free to read at issuance.

## Options considered
### Option 1: A mutable custom attribute `custom:scopes` on the user
Absent means "all of the tenant's scopes". Present, it holds the granted set.
In the single-tenant topologies the value is a space-separated list; in
topology 3 it is a JSON object keyed by tenant id, so one attribute serves
every membership. Pros: no extra read on the token path, no registry change,
ADR-0002 stands. Cons: a custom attribute, once added to a pool, cannot be
removed; the 2048-character limit bounds the number of scopes times tenants a
person can be cut on (about 60 scope names across tenants).

### Option 2: A user row in the registry table
`PK = TENANT#<id>`, `SK = USER#<username>`, `scopes`. Pros: unbounded, per
tenant by construction. Cons: one more read per tenant per issuance
(`BatchGetItem` in topology 3), a second user store, and ADR-0002 would be
superseded.

### Option 3: A Cognito group per tenant, scope and user
Pros: the trigger sees groups for free. Cons: "reduce" would have to be stored
as a deny group (`no-<tenantId>-<scope>`), which reads backwards, and a person
in many groups slows `AdminListGroupsForUser` in the users API.

## Decision
Option 1. `UpdateTenantUser` gains an optional `scopes` list; `GetTenantUser`
and `ListTenantUsers` return the effective scopes (`held` without the admin
scope, ADR-0035). The tenant-users function refuses, with 400 `invalid_scope`,
a list that names a scope the tenant is not entitled to, a duplicate, or
`tenant-admin/users` (admin stays a group, ADR-0015). An empty list is valid and
means the user gets no scope. A platform operator uses the platform
`UpdateUser` (`PATCH /platform/tenants/{tenantId}/users/{username}`) for the
same field with the same rules. The shared pool and the `pool-per-tenant`
provisioner add `custom:scopes` (mutable, string) to the pool schema; the
trigger reads it, never writes it.

## Consequences
A user attribute is readable by the user through `GetUser` with the
`aws.cognito.signin.user.admin` scope, which a narrowed token never carries
(P-6); the attribute is not sensitive in any case, since the token shows the
same set. Cutting a user takes effect at the next issuance, 5 min at most. A
tenant's own cut (`UpdateTenant`) wins by intersection: a user attribute that
still names a scope the tenant lost is harmless and is shown as not held. The
pool schema change is additive and deploys to an existing shared pool without
replacement.
