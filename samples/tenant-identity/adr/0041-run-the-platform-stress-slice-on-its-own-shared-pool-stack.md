# ADR-0041: Run the platform stress slice on its own `shared-pool` stack, with its own parameter

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (SA)

## Context
The platform stress test (`docs/stress-test.spec.md`, stress ADR-0002) tests
the samples composed as one platform. It needs a tenant-identity deployment
of its own: one user pool holds 10,000 groups, a `shared-pool` tenant takes
two, and the long-lived `TenantIdentity-shared-pool` stack in the test
account is shared by every integration run. Stress ADR-0002 asked to check
that this sample supports a second deployment with its own parameter prefix.
It supports half of that. `--context publishSharedParameters=false` (ADR-0017)
keeps a stack from writing the fixed `/application-plane/shared/identity/*`
parameters, but those parameters come with two account-wide, fixed-name
resources, the `AdminPasswordKey` alias and `PlatformInvokePolicy`, which
the same switch drops. The stress deployment therefore has no mount policy
and no admin-password key.

The slice also has to decide what it draws on the quota budget, what it
keeps between runs, and what its scenarios prove.

## Options considered
### Option 1: A second stack from a stress-only CDK app, `publishSharedParameters` off
`test/stress.identity.ts` builds one `TenantIdentityStack` named
`${STRESS_PREFIX}-identity`. Pros: no change to the stack or `main.ts`; the
stack cannot collide with the shared pool, whose names and parameters it
never touches; the prefix check refuses anything that starts with
`TenantIdentity`. Cons: no `PlatformInvokePolicy` and no admin-password key
for the control-plane mount (see Consequences).

### Option 2: Give the stack a parameter prefix and a key alias prop
Pros: the stress stack could publish its own mount policy and key under its
own names, and the control-plane slice could use the mount unchanged.
Cons: a change to the stack, the alias, ADR-0017 and the mount's `lib.sh`
(`IDENTITY_NS` is fixed there), for a consumer (W-5) that does not exist yet.

### Option 3: Reuse the shared pool, with a tenant cap
Pros: nothing new to deploy. Cons: `large` would drop to about 2,000
tenants, and a killed stress seed would leave groups in a pool every
integration run needs (stress ADR-0002, option 2).

## Decision
Option 1. The slice deploys one stack through `test/stress.identity.ts`, with
`cdk deploy --require-approval never`, and publishes one JSON parameter,
`/<prefix>/identity` (API URL, API id, pool id, app client id, Region; ids
only), for the next slice, so stress ADR-0002's "published under the stress
prefix" holds without a stack change. The stack is a fixture: `teardown`
keeps it, and keeps the seeded set at `large`, unless `--fixtures` is passed.
At `small` and `medium` the seeded set is run data and always goes.

The driver is TypeScript in `test/stress/`, on the end-to-end test's clients
(`test/e2e/clients.ts`), so the slice calls the API as a vendor and the
scenario do. Its choices:

- **Manifest.** `$STRESS_HOME/$STRESS_PREFIX/tenant-identity.json` lists
  tenant ids, user names and simulator e-mail addresses. A user's password is
  generated per run in memory and set by `IssueToken` (ADR-0006), so no
  password or token exists on disk. Tenant ids a scenario is about to create
  go into the manifest first, so a killed run leaves a trail `teardown`
  follows.
- **Seed.** In `slice` mode it creates the tier's `tenantsSeeded` tenants
  (admin plus `usersPerActiveTenant - 1` users for the active ones) at four
  calls a second, under the 10 rps platform throttle (ADR-0037), and checks
  the manifest's tenants first: a tenant that reads back 200 `ACTIVE` is
  reused, one that reads 404 is forgotten, and any other answer (a status in
  transition, or no answer after the retries) moves it to `transient`, so
  `teardown` deletes it instead of leaving it in a kept pool. In `platform`
  mode the control plane puts the
  tier's tenants into the pool, so the slice seeds a probe set of 20 and stays
  under the 5,000-tenant cap at `large`.
- **Scenarios.** `PS-1` onboards the tier's churn count at once (tenant,
  users, first token, each token verified against the pool) and times it from
  `CreateTenant` to the verified token. `token-rate` runs the steady rate for
  the scenario length as an open-loop mix of admin exchanges, platform
  refreshes and one cross-tenant probe in five. `create-tenant-burst` creates
  four times the churn count (runtime-isolation finding F-3), at most 100
  onboarding at once: each worker runs one tenant's whole onboarding, so up
  to 100 `CreateTenant` calls start together and the rest follow as workers
  free up. At `small` and `medium` that is every tenant at once; at `large`
  (400) the creates come in waves. The cap keeps the driver's own sockets and
  memory bounded. A 429
  or 503 is a counted result in `token-rate` and is waited out with backoff in
  the other two, using ADR-0037's recovery: read the tenant, then claim the
  first-admin slot, never repeat a blind create.
- **Isolation assertions (P-1).** Every token is verified against the stress
  pool and must carry `tenant_id` of the tenant it was issued for and no
  groups or tenants claim. Probes must be refused: a refresh token of A on
  B's platform path with A's username (ADR-0013's membership check), A's
  refresh token exchanged for B's resource, and, through the tenant admin
  door, B's user read with A's narrowed token and a list that names only A's
  users and, when it is complete, A's own admin (so an empty list cannot
  pass). A probe that is throttled is retried like the others; one that never
  answers is a finding, not a silent skip. One probe may be served: A's refresh token on B's path with the name
  of a real user of B passes the membership check, and `RefreshToken` does
  not tie the refresh token to the path's user. The assertion is that the
  answer is refused or names A, never B.
- **Observed finding (refresh path).** In the `small` run of 2026-11-19 that
  probe was served every time, and every token it returned named A. B's data
  is not reached, and the platform API is the vendor's own IAM-signed door,
  so this is a path-tenant mismatch, not a cross-tenant leak. The driver
  prints it as an `observed:` line. Binding the refresh token to the path's
  user (compare the token's `sub` or `username` to the path) is a change to
  `RefreshToken`, outside this ADR.
- **Findings.** A bare 5xx other than 503, and an operation that never
  finishes, fail the scenario. A bare 5xx is also counted as unattributed in
  the record (stress spec P-7).
- **Collect.** After a wait for CloudWatch to catch up (finding F-6, four
  minutes at most), API Gateway's `5XXError`, summed per record window (each
  widened to whole minutes, windows that share a minute merged, the gaps
  between scenarios left out), minus the 5xx the scenarios saw, minus the 5xx
  `seed` saw in the same minutes (seed writes them per minute to the
  manifest, with its run id), goes on the latest record as unattributed
  refusals. If `Count` has not reached 90% of the driver's calls by the
  deadline, `collect` exits 1 and the run fails: a late 5XX cannot be ruled
  out (P-7). In `platform` mode the identity API is shared with the control
  plane. Its 5XX between this slice's scenarios are not counted; its 5XX in
  the same minutes as one of them still are, and are charged to this slice.
  That stays a known limitation until W-5 decides how the control plane
  mounts the stress stack.
- **Budget.** The slice declares `cognito-groups` (two per tenant at the
  pool's peak, including the control plane's tenants in `platform` mode),
  `cognito-user-authentication-rps` (the highest of the steady rate, the 8 a
  second token-preparation pace, and the onboardings in flight at once in
  PS-1 or the burst times the users each one signs in, since those two do
  not pace their token calls: 40 at `small`, measured peak 26; 160 at
  `medium`, above the 120 default, so a `medium` run needs the account's
  applied quota in `--limits`) and `lambda-concurrency` (twice the
  steady rate for the token or platform function plus the trigger, or the
  burst concurrency). Each record's quota peaks are measured the same way:
  `cognito-groups` counts the control plane's tenants in `platform` mode, and
  `cognito-user-authentication-rps` is the busiest second of token calls in
  PS-1, the burst and `token-rate` (its preparation included). The catalogue has no id for the API Gateway control
  plane, which the deploy also draws on; it is added with the first slice
  that needs it (W-7).

## Consequences
Easier: the stress test seeds and destroys freely beside the integration
tests; `teardown --fixtures` removes the stack, parameter, pool, REST API and
log groups and fails when one is left. The manifest and the parameter go only
once the stack is gone: after a failed destroy both stay, as the trail a
rerun follows. Harder: the stress stack has no
`PlatformInvokePolicy` and no admin-password key, so the control-plane
mount's tenant script (which reads `/application-plane/shared/identity/*`)
cannot use it as is. The control-plane slice (W-5) needs option 2, or a
grant of its own built from the published API id; decide when W-5 starts.
Group counts in the budget are the pool's peak, not a quota read from the
account. Revisit when tenant-identity spreads tenants across pools (a stress
deployment could then hold more than 5,000 tenants) or when option 2 is built.
