# ADR-0026: Enforce the tenant boundary of tenant-user calls with IAM in `pool-per-tenant`

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
The tenant-user function (R-8) serves `/tenant/users` for whichever tenant
the authoriser verified. Its role could reach every pool this stack created
(`userpool/*` with the sample and stack tags, N-3), so the only thing that
kept tenant A's admin out of tenant B's pool was code: the provisioner picks
the pool from the registry row for the authoriser's tenant, and the R-12
membership check runs first (ADR-0013, ADR-0014). A bug in either is a
cross-tenant bug (threat model T-18). The SaaS Lens recommends tenant
isolation that does not rest on application code alone: scope the
credentials a request runs with to its tenant.

In `pool-per-tenant` each tenant owns a pool, and a pool is an IAM resource
with tags, so IAM can draw the boundary. In `shared-pool*` the tenants share
one pool and Cognito's user actions take the pool as their only resource:
IAM cannot tell one tenant's users from another's there.

## Options considered
### Option 1: Keep the code check only
Pros: no change. Cons: T-18 stays open for the one topology where IAM could
close it.
### Option 2: A role per tenant
Pros: the simplest policy. Cons: an IAM role created and deleted per
tenant at onboarding: IAM write permissions on the platform role, eventual
consistency on every new tenant, and the per-account role quota.
### Option 3: One tenant-scoped role, assumed per tenant with a session tag (ABAC)
Every new pool is tagged `tenant-identity:tenant=<tenantId>` (the tenant id
exists before the pool, ADR-0021). One `TenantScopedRole` grants the
tenant-user actions on `userpool/*` only where the pool's tenant tag equals
the session's `TenantId` tag. The tenant-user function assumes it per tenant
with the authoriser's tenant id as that tag. Pros: one role, no IAM writes at
onboarding; a session for A cannot reach B's pool even if the code picks B's
pool. Cons: an STS call per tenant per execution environment, cached; the
boundary is only as good as the tag on the pool and the tag on the session.

## Decision
Option 3, for `pool-per-tenant`; the shared topologies are unchanged.
- `CreateUserPool` writes three tags. The platform role's `CreateUserPool`
  and `TagResource` statements allow exactly the keys `sample`,
  `tenant-identity:stack` and `tenant-identity:tenant`, require the tenant
  tag shaped like a ULID (`StringLike`, 26 `?`). `TagResource` also requires
  `StringEqualsIfExists` on the sample and stack resource tags, so a pool
  that is already tagged must be this stack's. A `Null` ("no tags yet")
  guard was tried and fails: Cognito's create-time `TagResource` check is
  denied by it (integ 2026-10-22). The platform role can therefore re-tag
  its own stack's pools to another tenant; it already controls those pools
  fully, so this adds no reach (accepted with T-7).
- `TenantScopedRole` trusts only the tenant-user function's role, for
  `sts:AssumeRole` and `sts:TagSession`, and only with one session tag:
  `aws:RequestTag/TenantId` must match 26 characters and `aws:TagKeys` may
  hold `TenantId` and nothing else. The session tag key is `TenantId`, a plain
  key, so it reads cleanly in the `${aws:PrincipalTag/TenantId}` policy
  variable; IAM tag keys may contain `:` and `-`, but the pool tag already
  carries the namespaced name.
- Its one statement grants `TENANT_USER_ACTIONS` on `userpool/*` with
  `aws:ResourceTag/sample`, `aws:ResourceTag/tenant-identity:stack` and
  `aws:ResourceTag/tenant-identity:tenant = ${aws:PrincipalTag/TenantId}`.
- In `pool-per-tenant` the tenant-user function's own role holds no
  `cognito-idp` action, only `sts:AssumeRole` and `sts:TagSession` on that
  role. The function assumes it per tenant (`DurationSeconds` 900, the STS
  minimum; session name `tenant-<tenantId>` for CloudTrail), caches the
  credentials in the execution environment keyed by tenant, refreshes them
  two minutes before expiry plus up to 30 seconds of jitter, and builds one
  Cognito client per tenant from them (`src/tenant-api/tenant-credentials.ts`).
- The R-12 and R-13 checks stay: IAM is a second layer, not a replacement.

## Consequences
Easier: in `pool-per-tenant` a tenant admin's request cannot reach another
tenant's pool even if the provisioner or the R-12 check is wrong; T-18 is
closed for that topology at the IAM layer.

Harder:
- An `AssumeRole` per tenant per execution environment every ~13 minutes.
  STS allows 600 requests per second per account and Region by default,
  shared with every other `AssumeRole`, `GetCallerIdentity` and
  `GetSessionToken` call in the account
  ([IAM and AWS STS quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html),
  read 2026-10-22). The first call for a tenant in a cold environment adds an
  STS round trip.
- The boundary rests on the pool's tenant tag. The platform role can set it
  only on a new pool, and only the platform role creates pools; a pool
  created by hand, or before this change, has no tenant tag and is
  unreachable from `/tenant/*` until it is recreated.
- The shared topologies keep the code-only boundary: IAM cannot scope users
  inside one pool. The threat model (T-18) and the README say so.
- The platform function still holds the per-pool actions on every pool of
  the stack (it is the vendor's door, M-7); this ADR scopes the tenant door
  only.

Revisit if Cognito adds resource-level conditions for users inside a pool,
or if the shared topologies move to a pool per tenant tier.
