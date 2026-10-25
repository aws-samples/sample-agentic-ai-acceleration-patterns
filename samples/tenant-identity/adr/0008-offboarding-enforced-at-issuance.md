# ADR-0008: Enforce tenant offboarding at issuance, in the pre-token-generation trigger

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
The sample builds no request path for the services tenant users call
(ADR-0007), so a tenant-status check cannot live there. Cognito's token
model cannot express "this tenant is gone": `RevokeToken` and
`AdminUserGlobalSignOut` act on refresh tokens and sessions, not on
outstanding access tokens, and nothing stops a user from refreshing for the
refresh token's lifetime (one day) and receiving fresh access tokens that
still name a deleted tenant, unless the issuing side refuses. `DeleteTenant`
flips the registry item to `DELETING` before touching Cognito (R-11).

## Options considered
### Option 1: Rely on Cognito clean-up alone
Delete the pool (topology 1) or the users and group (2, 3). Pros: no trigger
logic. Cons: between the `DELETING` flip and the end of clean-up, and for any
user who remains because they belong to another tenant (3), refresh still
yields tokens naming the deleted tenant; a partial clean-up failure leaves
that window open indefinitely.
### Option 2: `AdminUserGlobalSignOut` every affected user before clean-up
Pros: ends sessions, so refresh fails. Cons: a multi-tenant user (3) loses
their session for tenants that still exist; adds a call per user to
`DeleteTenant`; still nothing checks status on refresh, so a user signing in
again during the window gets the claim back.
### Option 3: The trigger refuses non-`ACTIVE` tenants on every issuance
The trigger runs on sign-in and on refresh. It reads the tenant's status
from the registry and throws (1, 2) or drops the tenant from `tenants` (3)
when the tenant is `DELETING` or absent. Pros: issuance stops the moment
R-11 lands, before any Cognito clean-up; multi-tenant users keep working for
their remaining tenants; the rule is one branch in code that already reads
the registry for topology 1. Cons: the trigger reads the registry in all
three topologies, and a registry outage fails sign-in (acceptable: the
registry is already the record of which tenants exist).

## Decision
Option 3, uncached (N-9): issuance happens at sign-in and at most once per
access-token lifetime per session, so a cache would buy little and would
reopen the window it is meant to close. The rule applies to narrowed tokens
too (ADR-0010). Outstanding access tokens live out their lifetime, which N-1
pins at Cognito's minimum of five minutes; the README states that bound and
says a consumer needing a tighter one adds its own check. The tenant API's
authoriser is that check for `/tenant/*` (ADR-0007). Clean-up of pools,
groups, and users (P-4) still happens; it is what makes the deletion total,
not what makes it take effect.

## Consequences
Easier: one place enforces offboarding, testable at unit level with a
`DELETING` registry item (§10 step 10) and at integration level by
refreshing after `DeleteTenant` with the `RefreshToken` test aid (§10 step
9, ADR-0006). Harder: the trigger's role needs `GetItem`, `BatchGetItem`,
and `Query` on the registry in every topology (R-14); every issuance costs a
DynamoDB read. Revisit if issuance volume makes the read cost matter; the
first move would be a short cache with the window it opens documented.
