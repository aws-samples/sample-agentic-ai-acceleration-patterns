<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0017: Create each control-plane tenant's identity tenant and users in the control-plane driver

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md);
"front-door ADR" means a record in
[`samples/tenant-front-door/adr/`](../../samples/tenant-front-door/adr/).

A tenant the control plane onboards must also exist in the stress identity,
the `tenant-identity` deployment of stress ADR-0002, with users who can sign
in. Without that, no request for the tenant gets a token, so nothing is
served through the edge. Nothing creates it today. The tenant script of the
stress application subscribes the tenant on its cell and nothing else, and
the `tenant-identity` slice's `seed` creates tenants of its own. The
`agentic-runtime-isolation` slice drives only control-plane tenants that
`tenant-identity.json` lists with an admin user, so a platform run with no
identity tenants for the control plane's tenants refuses every tenant
(`no-identity-tenant`) and fails.

Four facts fix the options:

- tenant-identity `CreateTenant` takes an optional `tenantId`, so the
  identity tenant keeps the control-plane tenant id (tenant-identity
  ADR-0029). It creates the first admin. `CreateUser` creates each further
  user. Both are on the platform API, authorised with IAM (SigV4), and the
  `identity.json` manifest holds that API's URL.
- The tenant script runs in the control plane's tenant CodeBuild project
  under the cell account's role pair tenant role (control-plane ADR-0025).
  That role holds the control plane's SSM namespace grants and whatever the
  account owner attaches (control-plane ADR-0022): here, the cell's
  entitlement methods, and nothing in the platform account.
- Spec §5.1 times PS-1 from `CreateDeployment` to the first served request,
  and that request needs a token.
- The front door's own route is written by a control-plane global hook, not
  by the tenant script (front-door ADR-0017).

## Options considered
### Option 1: The driver of the `control-plane` slice
Right after a tenant's deployment is `ACTIVE`, the driver calls
`CreateTenant` with the control-plane tenant id, then `CreateUser` for each
further user the tier lists, with the IAM session it already uses for the
control plane, and then polls the edge.

Pros: the calls come from the runner's session and not from a build role,
so the cell account's tenant role gains no reach into the platform account
and a compromised tenant build cannot create identities; the driver already
knows each tenant's id, the tier's user count and when the deployment is
`ACTIVE`; the calls fall inside PS-1's timing without any new component; the
`tenant-identity` slice already has the call code, with its retry on
throttling, to copy; no change to another sample.

Cons: the driver does the work of a tenant script, and a platform run needs
the driver, not only the control plane, for identities; the `control-plane`
slice now reads `identity.json`; the driver must record what it created for
the runtime-isolation slice.

### Option 2: The tenant script
The tenant script calls `CreateTenant` and `CreateUser` before
`PutTenantSubscription`.

Pros: the control plane's own flow does it, with its retry and status;
a deployment is `ACTIVE` only when the identity exists.

Cons: the tenant role would need `execute-api:Invoke` on the platform
account's identity API, through the role pair. The owner attaches only the
cell's entitlement methods to that role today (control-plane ADR-0022), so
this crosses an account boundary that the pair does not cross. The script
needs the identity API URL and the users' addresses as inputs. A script that
fails halfway leaves an identity tenant that a retry must find (`CreateTenant`
answers 409 for an existing id).

### Option 3: A tenant-identity hook
`tenant-identity` registers a global hook with the control plane that creates
the identity tenant on `DEPLOYMENT_CREATE`, as the front door's route hook
does for routes (front-door ADR-0017).

Pros: the identity follows the control plane's event with no driver or
script code in the stress test; it would serve any vendor that composes the
two samples.

Cons: a change to `tenant-identity`, which has no control-plane hook, and a
hook project in the control plane's account; the hook cannot know how many
users or which addresses the tier wants, so users still need a caller;
a second global hook widens the set a platform deploy registers and tears
down (spec §3.5).

## Decision
Option 1. The driver of the `control-plane` slice, right after each
tenant's deployment is `ACTIVE`, calls tenant-identity `CreateTenant` with
the control-plane tenant id, then `CreateUser` for each further user the
tier lists (spec §4.1, which counts the admin among the users), through the
IAM-signed platform API at the `apiUrl` of `identity.json`. The tenant
script keeps only the entitlement call. The calls are part of PS-1's time to
the first served request. The driver never writes a temporary password or a
token to disk (spec §4.2).

The driver records the admin and users it creates. The runtime-isolation
slice reads that record for control-plane tenants, in place of the lookup
in `tenant-identity.json` that only the `tenant-identity` `seed` writes.

## Consequences
Easier: the tenant role stays an entitlement-only role, and the identity
admin API is called from one place, the session of the run. PS-1 shows the
cost of a ready tenant including its identity, which a vendor's own
onboarding would also pay.

Harder: each onboarded tenant adds identity calls to the stress identity's
Cognito quotas. At the shared-pool topology, `CreateTenant` creates two
groups (`UserPoolResourceUpdate`, 15 requests a second, not adjustable) and
its admin (`UserCreation`, 50 a second, adjustable), and each further user
adds a user and a group membership (`UserUpdate`, 25 a second, not
adjustable) (tenant-identity README, Cognito quotas). Builds pace onboarding
at `buildLimit` per project, which is far below these rates at `small`, but
a churn burst at `medium` or `large` can reach them. The driver retries a
throttled call with backoff, as the `tenant-identity` slice's calls do, and
spec §4.4 lists the draw in the `control-plane` column. A throttled call
shows in PS-1's time, which is a result, not an error.

The `control-plane` slice now needs `identity.json`, and so reads a
manifest that it did not before. The runtime-isolation slice reads the
driver's record of identity tenants (spec §4.2). Until the driver and the
record exist, the runtime-isolation slice refuses every control-plane tenant
and a platform run fails with the list.

W-9 implements: the driver's identity calls after each tenant's deployment
is `ACTIVE`; the record of the admin and users it creates, in a manifest
the runtime-isolation slice reads for control-plane tenants (a field per
`seeded[]` tenant in `control-plane.json` is the smallest change); the
identity API grant on the driver's session; retry on throttling; the
Cognito draw in the slice's `budget`; and the cleanup of those identity
tenants at teardown, since the `tenant-identity` `teardown` knows only the
tenants it seeded. Revisit if the tenant-identity sample gains a
control-plane hook, or if a vendor's real onboarding flow shows a better
home for the call.
