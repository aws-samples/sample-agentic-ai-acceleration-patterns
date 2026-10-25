# ADR-0013: Check that a user belongs to the path's tenant before any per-user platform operation

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Per-user platform routes take both a tenant and a user:
`/platform/tenants/{tenantId}/users/{username}`. In `pool-per-tenant` the
tenant picks the pool, so a user of another tenant is simply not found. In
the shared pools every user lives in one pool, and a username is enough for
Cognito. As specified, `DeleteUser` for tenant A with a username from tenant
B would delete B's user in `shared-pool`; in `shared-pool-multi-tenant`,
`DeleteMembership` and `DeleteUser` would act on a user who is not in A, and
the test aids would issue tokens for B's user through A's path (threat model
T-16). The path names a tenant; the operation must stay inside it.

## Options considered
### Option 1: Trust the caller; the platform API is vendor-only
Pros: no extra Cognito calls. Cons: the path promises a tenant scope the
code does not keep. A vendor script with a wrong tenant id deletes another
tenant's user, which is the cross-tenant mistake the sample teaches against.
### Option 2: Drop the tenant from per-user paths
Pros: the API says what it does. Cons: loses the tenant context the
provisioner needs in topology 1, and breaks one contract across topologies
(P-1).
### Option 3: The provisioner checks membership first and answers 404 when the user is not in the tenant
Pros: one rule in every topology, inside the provisioner where topology
knowledge already lives (P-1). 404, not 403, so the vendor API does not say
whether the user exists in another tenant. Cons: one extra Cognito read per
call (`AdminGetUser` or `AdminListGroupsForUser`).

## Decision
Option 3. Every per-user operation except `CreateUser` and `CreateMembership`
(`DeleteUser`, `DeleteMembership`, `IssueToken`, `RefreshToken`) first asks
the provisioner whether the user belongs to the tenant. Topology 1: the user
exists in the tenant's pool. Topology 2: `custom:tenantId` equals the path's
tenant. Topology 3: the user is in group `t-<tenantId>`. If not, the call
fails with `ResourceNotFoundError` (404) and changes nothing. `CreateMembership`
is the one operation that crosses tenants by design; it is vendor intent and
topology 3 only.

## Consequences
Easier: a wrong tenant id in a vendor call cannot reach another tenant's
users; the rule is testable once in the shared scenario. Harder: one more
Cognito read per call, inside Cognito's admin API quotas at vendor scale;
the platform role needs `AdminGetUser` and `AdminListGroupsForUser`, scoped
like its other actions (N-3). The check and the action are two calls, so a
concurrent membership change can race them; at vendor scale that is
accepted.
