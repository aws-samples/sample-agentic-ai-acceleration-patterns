<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0017: Create each control-plane tenant's identity tenant and users in the control-plane driver

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0012
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md);
"front-door ADR" means a record in
[`samples/tenant-front-door/adr/`](../../samples/tenant-front-door/adr/),
"tenant-identity ADR" a record in
[`samples/tenant-identity/adr/`](../../samples/tenant-identity/adr/), and
"control-plane ADR" a record in
[`samples/control-plane/adr/`](../../samples/control-plane/adr/).

A tenant the control plane onboards must also exist in the stress identity,
the `tenant-identity` deployment of stress ADR-0002, with users who can sign
in. Without that, no request for the tenant gets a token, so nothing is
served through the edge. The `agentic-runtime-isolation` slice drives only
control-plane tenants that it can match to an identity tenant with an admin
user (spec §4.2), so a platform run with no identity tenants for the
control plane's tenants refuses every tenant (`no-identity-tenant`).

`tenant-identity` ships a control-plane mount for this: the tenant script
`scripts/control-plane/tenant/create.sh` calls `CreateTenant` under the
control-plane tenant id (tenant-identity ADR-0028, ADR-0029). A reader of
the spec might expect the stress application's tenant script to make that
call; spec §3.3 step 3 says it does not. The mount assumes the tenant build
runs in the identity's own account: the platform API admits the account
root, and the tenant build role gets its permission from
`PlatformInvokePolicy` (tenant-identity ADR-0030), so both sides allow the
call only in the same account (tenant-identity
`design/control-plane-mounting.spec.md` §3.3). The stress application's
tenant script runs under the role pair's tenant role in a cell account
(control-plane ADR-0025), which is a different account from the stress
identity (spec §3.1).

Four facts fix the options:

- `CreateTenant` takes an optional `tenantId`, so the identity tenant keeps
  the control-plane tenant id (tenant-identity ADR-0029). It creates the
  first admin. `CreateUser` creates each further user. Both are on the
  platform API, authorised with IAM (SigV4); `identity.json` holds the API's
  URL (spec §4.2).
- The tenant script's role holds the control plane's SSM namespace grants and
  whatever the account owner attaches (control-plane ADR-0022): for the
  stress application, the cell's entitlement methods and nothing in the
  platform account.
- Spec §5.1 times PS-1 from `CreateDeployment` to the first served request,
  and that request needs a token.
- The front door's route is written by a control-plane global hook, not by the
  tenant script (front-door ADR-0017).

## Options considered
### Option 1: The driver of the `control-plane` slice
Right after a tenant's deployment is `ACTIVE`, the driver calls
`CreateTenant` with the control-plane tenant id, then `CreateUser` for each
further user the tier lists, with the AWS session the run already holds (the
driver signs PS-5's registrar calls with it), not the operator token it uses
for the control plane, and then polls the edge.

Pros: the calls come from the run's AWS session in the platform account,
which the platform API admits, and not from a build role, so the cell
account's tenant role gains no reach into the platform account and a
compromised tenant build cannot create identities; the driver already knows
each tenant's id, the tier's user count and when the deployment is `ACTIVE`;
the calls fall inside PS-1's timing without a new component; the
`tenant-identity` slice already has the call code to copy; no change to
another sample.

Cons: the driver does the work of a tenant script, and the stress test does
not exercise the sample's own mount; the `control-plane` slice reads
`identity.json`; the driver must record what it created for the
runtime-isolation slice and delete it at teardown, because the control
plane's `DeleteDeployment` does not reach the identity.

### Option 2: The tenant script, through the tenant-identity mount
The tenant script runs the sample's own `create.sh` (or calls `CreateTenant`
and `CreateUser` itself) before `PutTenantSubscription`.

Pros: it is the sample's own design, with its replay safety and its parking
of the first admin's password; a deployment is `ACTIVE` only when the
identity exists; `DeleteDeployment` removes the identity through the mount's
delete script.

Cons: it cannot work from a cell account as the platform API is set up: the
resource policy admits the platform account root only. Making it work takes a
resource-policy change in `tenant-identity` that admits the role pair's tenant
role in each cell account, and `PlatformInvokePolicy` attached in each cell
account, which gives every tenant build there a way to create and delete
tenants in the stress identity. The role pair is built to hold the cell's
entitlement methods only (control-plane ADR-0022, ADR-0025). In the variant
where the script calls `CreateTenant` itself, a script that fails halfway
leaves an identity tenant that a retry must find (`CreateTenant` answers 409
for an existing id); `create.sh` reads state first and avoids it.

### Option 3: A tenant-identity hook
`tenant-identity` registers a global hook with the control plane that creates
the identity tenant on `DEPLOYMENT_CREATE`, as the front door's route hook
does for routes (front-door ADR-0017).

Pros: the identity follows the control plane's event with no driver or
script code in the stress test; it would serve any vendor that composes the
two samples.

Cons: a change to `tenant-identity`, which has no control-plane hook, and a
hook project in the control plane's account; the hook cannot know how many
users or which addresses the tier wants, so users still need a caller; a
second global hook widens the set a platform deploy registers and tears down
(spec §3.5).

## Decision
Option 1. The driver of the `control-plane` slice, right after each
tenant's deployment is `ACTIVE`, calls tenant-identity `CreateTenant` with
the control-plane tenant id, `scopes` `["app/use"]` (the scope floor the
ingress requires on every token) and an admin e-mail address, then
`CreateUser` for each further user the tier lists (spec §4.1 counts the
admin among the users), through the IAM-signed platform API at the `apiUrl`
of `identity.json`. It does this for each tenant PS-1 onboards, for the
warm-up tenant (after front-door phase two) and for the `large` fleet's
seed, as spec §3.3 step 4 says. The tenant script keeps only the
entitlement call. The calls are part of PS-1's time to the first served
request. The driver never writes a temporary password or a token to disk
(spec §4.2).

The driver records the admin and users it creates in `identity[]` of
`control-plane.json`. The runtime-isolation slice reads that list for
control-plane tenants, in place of the lookup in `tenant-identity.json` that
only the `tenant-identity` `seed` writes (spec §4.2).

## Consequences
Easier: the tenant role stays an entitlement-only role, and the identity
admin API is called from one place, the session of the run. PS-1 shows the
cost of a ready tenant including its identity, which a vendor's own
onboarding would also pay.

Harder: each onboarded tenant adds identity calls to the stress identity's
Cognito quotas. At the shared-pool topology, `CreateTenant` creates two
groups (`UserPoolResourceUpdate`, 15 requests a second, not adjustable), its
admin (`UserCreation`, 50 a second, adjustable) and the admin's two group
memberships (`UserUpdate`, 25 a second, not adjustable). Each further user
adds a user and a group membership. Each call also looks the address up with
`ListUsers` (`UserList`, 30 a second, not adjustable) (tenant-identity
README, Cognito quotas). The platform API itself has a stage throttle of 10
requests a second (tenant-identity ADR-0037).

The first platform run at `small` onboards 20 tenants, and builds that start
together finish close together, so the driver can have up to 20
`CreateTenant` calls (40 `CreateGroup` calls) to make within seconds.
Against 15 requests a second that can throttle. The platform API has a
10 requests a second stage throttle, but the group quota is the likely
limit first: at 8 `CreateTenant` calls a second the driver makes 16
`CreateGroup` calls a second, and a seed at 8 requests a second answered
500 on most calls (tenant-identity ADR-0037). So the driver paces
`CreateTenant` and `CreateUser` at about four calls a second, as the
`tenant-identity` seed does (tenant-identity ADR-0042). A throttle that
remains shows in PS-1's time, which is a result, not an error. Spec §4.4
lists the draw in the `control-plane` column.

A throttled `CreateTenant` answers 503, and it may have created the tenant
without its admin (tenant-identity ADR-0037). A blind repeat then answers
409 and the tenant stays without an admin, which the runtime-isolation slice
refuses as `no-user`. So on a 503 or a 409 the driver claims the first-admin
slot with `CreateUser` and `firstAdmin`, where a 409 means the admin exists
and a 404 means the tenant was removed by `CreateTenant`'s own compensation,
so the driver repeats `CreateTenant`. It repeats the other calls with
backoff.

The stress test does not exercise the sample's own mount, so a defect in
`create.sh` or in `PlatformInvokePolicy` is not found by it. The sample's
joint control-plane mount test covers it (tenant-identity
`integration-test.md`).

The `control-plane` slice needs `identity.json`, a manifest of the
`tenant-identity` slice, and its driver holds two credentials: the
operator token for the control plane and the AWS session for the platform
API. The
runtime-isolation slice reads `identity[]` of `control-plane.json` (spec
§4.2). Until the driver writes it, the runtime-isolation slice refuses every
control-plane tenant and a platform run fails with the list.

W-9 implements: the driver's identity calls after each tenant's deployment
is `ACTIVE`, with the scope and e-mail address above; `identity[]` in
`control-plane.json`, read by the runtime-isolation slice for control-plane
tenants; `execute-api:Invoke` on the platform API for the driver's session;
pacing at about four calls a second, retry with backoff, and the rule above
for a half-created tenant; the Cognito draw in the slice's `budget`; the
comment in `stress/application/scripts/tenant/create.sh`, which says the
identity tenant joins that script when the slices compose; and the
cleanup, in the `control-plane` `teardown`, of the identity tenants of every
deployment of the run that has one: the seeded tenants of `small` and
`medium` and, at `large`, the churn tenants PS-1 is timed on, which PS-5
deleted. The `large` fleet's identity tenants stay with the fixture. The
cleanup is needed because the control plane's `DeleteDeployment` does not
remove them and the `tenant-identity` `teardown` knows only the tenants it
seeded. Revisit if the tenant-identity sample gains a control-plane hook, or
if the platform API admits cell-account roles.
