# ADR-0021: Write the registry row before provisioning Cognito

- Status: Accepted
- Date: 2026-10-22
- Deciders: Dave Roberts (SA)

## Context
`CreateTenant` used to provision Cognito first (a pool in topology 1, two
groups in 2 and 3) and write the registry row afterwards. A Lambda timeout,
a crash, or a registry outage between the two left Cognito resources that no
registry row named. `ListTenants` could not show them, `DeleteTenant` could
not remove them, and in `pool-per-tenant` that is an orphan user pool with a
live issuer. A blind security review found it on 2026-10-22 (spec R-11 had
the delete side right: status first, Cognito second; the create side did not
mirror it).

## Options considered
### Option 1: Registry row first, as `PROVISIONING`, then flip to `ACTIVE`
Pros: every Cognito resource the sample creates has a row from before it
exists, so a failed onboarding is visible (`GetTenant`, `ListTenants`) and
removable (`DeleteTenant` on a `PROVISIONING` row). The trigger and the
authoriser already refuse anything that is not `ACTIVE`, so the new status
needs no new rule. Cons: a third status; one more conditional write; a
window of a few milliseconds in topology 1 between `CreateUserPool` returning
and the row learning the pool id, in which a crash still orphans the pool.
### Option 2: Keep Cognito first and add a reconciliation job
Pros: no new status. Cons: a scheduled job that lists tagged pools and
compares them to the registry is more code, needs `ListUserPools` on `*`,
and only finds the orphan later.
### Option 3: Keep Cognito first and accept the gap
Pros: no change. Cons: the delete side already shows the right pattern;
leaving the create side asymmetric is hard to defend.

## Decision
Option 1. `CreateTenant` writes `{status: PROVISIONING}` with no Cognito
fields, provisions, then runs one conditional update (`status =
PROVISIONING` → `ACTIVE` plus the pool or group fields). A provisioning
failure deletes the row; an activation failure deprovisions and deletes.
Every mutation and both token test aids refuse a `PROVISIONING` tenant with
409, exactly as they refuse `DELETING`; reads return it.

## Consequences
Easier: no Cognito resource exists without a registry row that names its
tenant, and a half-onboarded tenant is a normal `DeleteTenant`. Harder: the
Smithy `TenantStatus` enum and the spec's §4.1 and §5.1 carry a third value,
and clients that switch on status must handle it. The residual
`CreateUserPool`-to-row window in topology 1 is the pool's tag and name
(`tenant-identity-<tenantId>`) away from a manual clean-up; revisit if a
deployment needs stronger onboarding guarantees than a sample.
