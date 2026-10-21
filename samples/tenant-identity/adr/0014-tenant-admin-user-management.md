# ADR-0014: Let a tenant admin manage their own tenant's users, through a second front door to the provisioner

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
The vendor manages users through `/platform/*` with IAM (ADR-0005). Real multi-tenant applications hand that job to the tenant: the
vendor creates the tenant and its first admin at onboarding, and the tenant
admin then creates, reads, updates, deletes, and lists the users of that
tenant. The vendor keeps full rights to every user for support,
offboarding, and legal holds. Token exchange (ADR-0009) makes tenant admin the
natural first role: a tenant admin is exactly the caller who should act with a token that names
one tenant and carries the admin scope, and nothing more.

## Options considered
### Option 1: Keep user management vendor-only; roles stay a seam
Pros: the sample verifies no tokens. Cons: the narrowed token has no
consumer either, so the sample shows how to narrow but never why. Every
reader builds tenant self-service from scratch, and that is where
cross-tenant bugs live.
### Option 2: Tenant admins call Cognito directly with their own token
Pros: no API to build. Cons: Cognito's user-token APIs act only on the
caller (`GetUser`, `UpdateUserAttributes`); there is no user-token call to
create or delete another user. Not possible.
### Option 3: A `/tenant/users` route family, tenant from the token, reusing the provisioner
Pros: the same provisioner operations serve both doors (P-1); the vendor
names the tenant in the path, the tenant admin's tenant comes from the
verified token; the membership check of R-12 (ADR-0013) is the same check
on both doors. Cons: the sample now consumes tokens on one route family
(ADR-0007), and needs an admin role (ADR-0015).

## Decision
Option 3. `CreateTenant` takes a required `adminEmail` and creates the
tenant's first admin with it. `/tenant/users` offers create, get, update
(the admin flag only), delete, and list, scoped to the token's `tenant_id`;
a tenant admin cannot delete or demote themselves, so a tenant always keeps
at least one admin through this door. The vendor keeps every operation on
`/platform/*` and gains `GetUser`, `ListUsers`, and `UpdateUser` so its
rights stay a superset of the tenant admin's. A separate tenant-user
function serves `/tenant/users`; its role holds the Cognito user actions
and none of the pool or group lifecycle actions (P-8).

To list a tenant's users with one call in every topology, `shared-pool`
also puts each user in group `t-<tenantId>`. The `tenant_id` claim still
comes from the immutable attribute (P-3); the group is for listing only.

## Consequences
Easier: the sample shows the full path a reader will build: narrow, call,
verify, act inside one tenant. Harder: one more function, route family, and
authoriser; the `shared-pool*` tenant-user role can reach every user in the
pool, so tenant isolation for that function is enforced in code (R-12), not
by IAM, and the threat model says so. In `shared-pool` and
`shared-pool-multi-tenant` two groups per tenant halve the tenant ceiling
per pool to 5,000 (10,000 groups per pool). Tenant `CreateTenantUser` with an
e-mail that already exists under another tenant answers differently from a
new e-mail, which reveals that the address is known to the vendor; accepted
for the sample (threat model).
