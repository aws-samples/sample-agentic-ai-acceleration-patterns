<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: specification

- Status: Accepted
- Date: 2026-11-18
- Scope: four samples composed as one agent platform: `control-plane`,
  `tenant-identity`, `tenant-front-door` and
  `agentic-runtime-isolation`

## 1. Problem statement

Each sample proves its own claims. `agentic-runtime-isolation` has a stress
test that held isolation over about 1.9 million requests at up to 4,000
tenants, 100 agents and 1,000 tools. Nothing yet tests the samples as the
platform they are built to be: a tenant onboarded by the control plane into
a cell, given an identity by tenant-identity, routed by the front door, and
served by an agent behind the runtime-isolation ingress.

Three questions are open, and none of them can be answered one sample at a
time:

| Question | Why one sample cannot answer it |
|---|---|
| How fast does the platform make a tenant ready to use? | onboarding crosses the control plane, CodeBuild, tenant-identity, the Entitlements API and the route registrar |
| What does the front door add, and does it stay correct at 1,000s of tenants across cells and accounts? | the edge, the route table and the cell origins only exist together |
| Do tenants that are added, suspended or removed reach the right place, and how soon? | churn is a control-plane write that the edge and the ingress must both see |

A fourth question is a side effect of composition: the samples share
account-wide quotas (Lambda concurrency, STS, KMS, CodeBuild, the API
Gateway control plane). The per-sample runs never draw on them together.

Deployment model: pool at the edge and in identity; cells behind the edge,
in cell accounts that hold nothing but cells, each cell a pooled
runtime-isolation deployment for up to `maxTenants` tenants.

### 1.1 What the test shows

- Onboarding rate and time to ready, from `CreateDeployment` to the first
  served request through the edge, for every tenant but the warm-up
  tenant that builds the first cell (§3.5).
- Latency per hop under load for agent calls: edge, router, ingress,
  Runtime and tools.
- Isolation end to end: every request checks the tenant at the layers
  its path crosses (§5.3): the ingress and the vended credential for
  agent calls, under load; the edge and the cell for `/api/*` calls.
- Churn: route updates seen at the edge within a measured time;
  suspended and removed tenants refused at the edge, never at an origin.
- The shared quota that gives out first at each tier, with the tenant it
  hits.
- Deploy and destroy time of every slice and of the whole platform.

### 1.2 What the test does not do yet

- `tenant-memory-isolation` and `tenant-encrypted-ingestion`. Each joins as
  a slice (§3.4) once the first four run together.
- The front door's `host` addressing mode and custom domains. The first
  runs use `single`, the default.
- The `agentcore-gateway` ingress of runtime-isolation.
- Platform runs at `medium` and `large`: per-cell agent routing is open
  (Q-7, stress ADR-0016). At `small` the edge check on agent calls reads
  no route hint (§5.3).
- Several Regions.
- Churn and cross-cell probes under load. The runner runs scenarios one
  after another, so PS-5 and PS-7 run without PS-2's load beside them
  (§5.1, stress ADR-0021).
- Soak runs over days. One platform run is a working day at most.

### 1.3 What the test is NOT

- Not a construct and not part of any sample's deployed stacks. The driver
  and the stress application are test assets.
- Not a benchmark of AWS services. Quotas are inputs; a quota reached on
  purpose is a result.
- Not a pull request gate. It runs on demand, at a tier, by a person.
- Not a replacement for each sample's integration test, which still proves
  the sample alone.

## 2. Guiding principles

**P-1. Every request is an isolation assertion.** The driver knows the
tenant each request is for, and every response says which tenant served it.
One mismatch fails the run, at any rate. A wrong answer under load is a
leak, not a slow path.

**P-2. Compose through published interfaces.** The platform run wires the
samples the way a vendor would: through each producer's published
parameters and API, as the sample standard §1.1 requires. A slice may read
its own stack outputs; it never reads another sample's.

**P-3. One contract, many slices.** The repository holds one shared
contract: tiers, the driver, the k6 library, the result format and the
quota budget. A sample joins by implementing the slice verbs (§3.4) for its
own part. A slice runs alone or as part of the platform run, with the same
code.

**P-4. Budget the shared quotas before the run.** Each slice declares the
account-wide quotas it draws on and how much at each tier. The runner adds
them up per account and refuses to start when a sum is over the quota.
Splitting cells across accounts spreads the per-account quotas, and the
budget shows by how much.

**P-5. Pay for a large fleet once.** At `large`, onboarding thousands of
tenants through CodeBuild takes hours. The fleet is seeded once through the
control plane and kept as a fixture. Each run reuses it and onboards only a
churn slice.

**P-6. Deploy and destroy time are results.** Every slice reports both,
next to its functional results. A slice that cannot be destroyed cleanly
fails.

**P-7. A refusal names a tenant.** Under load every 4xx and 5xx is
attributed to a tenant and a reason in a log line. A bare 500, or a refusal
the driver cannot attribute, is a finding.

**P-8. Smaller tier first.** A run is green at `small` before `medium`, and
at `medium` before `large`. A failure is fixed and rerun at the tier where
it first shows.

## 3. System shape

### 3.1 Components

| Component | Where | What it is |
|---|---|---|
| Contract | `stress/` at the repository root | `src/`: tiers, slice declaration, quota budget, result records, runner (`run.sh`); the k6 library (`stress/k6/`) |
| Driver host | `stress/driver/`, its own CDK app (stress ADR-0009) | one EC2 instance, no inbound rule, no public IP, SSM Session Manager, k6 and the AWS CLI |
| Stress application | `stress/application/` | a control-plane application whose cell scripts deploy one runtime-isolation cell with a cell API origin and whose tenant scripts subscribe one tenant on its cell (§3.3) |
| Slice: `control-plane` | `samples/control-plane/scripts/stress/` | deploy the control plane, register accounts and the stress application, onboarding and churn scenarios; its driver creates each onboarded tenant's identity tenant and users (§3.3 step 4, stress ADR-0017) |
| Slice: `tenant-identity` | `samples/tenant-identity/scripts/stress/` | the platform's identity deployment, token issue and refresh scenarios |
| Slice: `tenant-front-door` | `samples/tenant-front-door/scripts/stress/` | the edge, route writes, edge scenarios |
| Slice: `agentic-runtime-isolation` | `samples/agentic-runtime-isolation/scripts/stress/` (exists) | the cell's ingress, agents and tools; scenarios S1 to S7 |
| Fixture: stress identity | the platform account | a `tenant-identity` `shared-pool` deployment for the stress test only, so 4,000 stress tenants never crowd the pool every integration run shares |
| Fixture: fleet | every account | at `large`, the seeded tenants, deployments, cells and routes, kept between runs (P-5) |
| Platform account | a non-production account | the control plane, the edge, the route registrar, the stress identity and the driver host; never a cell |
| Cell accounts | one or two standalone non-production accounts | registered with the control plane; hold only the four kinds of stack in §3.7 |

### 3.2 Topology

```
                 ┌────────── platform account ──────────────────────────────┐
 driver host ───►│ CloudFront distribution ─► tenant router (KVS lookup)    │
 (k6)            │ control plane ─► CodeBuild ─► cell and tenant scripts    │
                 │ stress identity (tenant-identity shared pool)            │
                 │ route registrar                                          │
                 └──────┬──────────────────────────────────────┬────────────┘
                        │ /api/* origin, role pair             │
          ┌─────────────▼── cell account A ──────┐   ┌─────────▼── cell account B ──────┐
          │ cell A1 ─► runtime-isolation ingress │   │ cell B1 ─► runtime-isolation     │
          │ cell A2 ─► runtime-isolation ingress │   │ cell B2 ─► runtime-isolation     │
          └──────────────────────────────────────┘   └──────────────────────────────────┘
```

Every cell trusts the same issuer, the stress identity. The front door's
edge stack and edge logging stack are in `us-east-1`, as its
specification requires; everything else is in `eu-central-1`. The
driver host sits in the platform account, so it never shares an account
with a cell build. The picture shows `large` and only the `/api/*`
origins; at `small` there is one cell account with one cell, and agent
calls go from the edge to that cell's ingress (§3.3, stress ADR-0016).
At `medium` and `large`, how agent calls reach each cell's ingress is
Q-7.

### 3.3 Paths

"Front-door spec" and "front-door ADR" below mean
[`samples/tenant-front-door/design/tenant-front-door.spec.md`](../samples/tenant-front-door/design/tenant-front-door.spec.md)
and the records in
[`samples/tenant-front-door/adr/`](../samples/tenant-front-door/adr/).

**Onboarding** (one tenant, through the control plane):

1. The driver calls control-plane `CreateTenant`, then `CreateDeployment`
   for the stress application.
2. The control plane places the deployment. If the cell is new, its cell
   script runs first: from the repository at a pinned commit, it deploys
   one runtime-isolation cell (ingress, agents, tool targets) and a cell
   API origin, the front door's demo cell API
   (`samples/tenant-front-door/src/demo-cell/`, bundled from the pinned
   commit, W-5), with its `CellRouteAccess`, which takes the
   distribution ARN from a cell parameter (§3.5). The origin verifies
   the token, refuses a hint that is not the token's tenant and a
   tenant its cell's account does not host with 403, and answers with
   the tenant, its cell id and the hint it received on
   `GET /api/whoami` (front-door spec §3.5, §10 step 4). The script
   writes the cell API's `frontDoorApiDomain` to its outputs, which the
   front door's global post hook reads to register the cell route
   (`PutCellRoute`) with the route registrar (front-door spec §3.2,
   front-door ADR-0017). The cell API origin, the cell parameter and
   the output exist in the platform run only: in `slice` mode there is
   no front door, the cell parameter has no value and the cell script
   deploys none of them. The ingress publishes its own parameter in the
   cell account, as runtime-isolation does (front-door spec §6.3). The
   cell sets `publishParameters` to false, so two cells in one account
   do not overwrite each other, and the parameter sits under the cell's
   stack name:
   `/application-plane/shared/agent-runtime/StressCell-<cellId>/ingress`.
3. The tenant script runs `PutTenantSubscription` on the cell ingress's
   Entitlements API and makes no call to the identity or to the route
   registrar. It records the deployment in the parameter
   `/application-plane/tenants/<tenant id>/stress/deployment`, below the
   namespace the cell API's hosts check reads; the delete script and the
   slice's read-back use the same name. It does not run tenant-identity's
   own control-plane mount (`scripts/control-plane/tenant/create.sh`),
   because the platform API admits a caller in the identity's own account
   only, the tenant role runs in a cell account, and the stress identity
   has no mount policy or shared parameters (stress ADR-0017). It
   does not call `PutTenantRoute`: the front door's global post hook
   writes the tenant route once the deployment's event has run
   (front-door ADR-0017, front-door spec §3.2).
4. In a platform run, when the deployment is `ACTIVE`, the driver of the
   `control-plane` slice creates the tenant's identity through the
   IAM-signed platform API of the stress identity (stress ADR-0017). It
   calls tenant-identity `CreateTenant` with the control-plane tenant
   id, `scopes` `["app/use"]` and an admin e-mail address, which creates
   the first admin. The scope is the vendor scope the slice-mode tenants
   carry; the driver puts it in the identity's scope catalogue with
   `PutScope` first, as the runtime-isolation `deploy` does in slice
   mode. Then it calls `CreateUser` for each further user the tier lists
   (§4.1). The driver paces the identity calls at about four a second
   and repeats a throttled call with backoff, with the first-admin rule
   of stress ADR-0017 for a half-created tenant. It does this for each
   tenant PS-1 onboards, for the warm-up tenant (after front-door phase
   two, §3.5) and for the `large` fleet's seed. PS-5 makes no identity
   call, because its probes need no token (§5.1); at `large` its tenants
   are the churn tenants that PS-1 onboarded, whose identity tenants
   remain until teardown (§4.2). The `large` parts are not built yet
   (stress ADR-0017; tiers above `small` wait for Q-7). The driver then
   polls through the edge with the admin's token until `GET /api/whoami`
   is served: the cell API answers with the verified tenant and the
   route hint, which is the isolation assertion of §5.3 (stress
   ADR-0020; the agent path is the load scenarios'). The identity calls
   and the polling are part of PS-1's time to the first served request
   (§5.1). The run's first tenant is the warm-up tenant of §3.5: its
   deployment builds the cell, and `/agents/*` is refused at the edge
   (404, or CloudFront's own 403 for a `POST`) until front-door phase
   two, so it is left out of PS-1's percentiles and timed apart as
   `warm-up-ready`, which also holds the set-up between the warm-up step
   and PS-1 (§5.1). In slice mode there is no front door and no token,
   and the driver makes no identity call.

**Request** (one prompt). At `small` the tier has one cell, and the
front door's `agentIngress` input is that cell's ingress (stress
ADR-0016). CloudFront sends `/agents/*` to it once the router has set
the hint and stripped `/agents`; nothing sits between the edge and the
ingress. The router's per-cell origin applies to `/api/*` only
(front-door spec §3.3 step 7):

```
k6 ─► CloudFront ─► tenant router ─► ingress authoriser
   ─► TVM ─► Runtime agent ─► tools gateway ─► tool
```

The router reads the tenant from the token, refuses an unknown or
suspended tenant, sets the route hint and strips `/agents` from the path
(front-door spec §3.3 steps 6 and 7, front-door ADR-0019). The ingress
verifies the token and takes the tenant from it; the agent reports the
tenant on its transaction token and on its vended credential. The
ingress does not echo the route hint (§5.3).

An `/api/*` request takes the router's cell origin instead:

```
k6 ─► CloudFront ─► tenant router ─► cell origin (origin access control)
```

The cell checks the route hint against the verified token (front-door
spec §3.5).

`medium` and `large` have more than one cell, and the front door has one
`agentIngress`. Per-cell agent routing for those tiers is Q-7; no run
above `small` starts until it is decided.

**Churn** (after PS-4, §5.1): `CreateDeployment`,
`UpdateTenantRouteStatus` to suspended and back, and `DeleteDeployment`,
each on a tenant the steady set does not use, each timed from the call
to the first edge response that shows it.

### 3.4 Slice contract

A slice is one executable, `scripts/stress/slice.sh`, in its sample, plus
a declaration, `scripts/stress/slice.json`.

| Verb | Does | Must |
|---|---|---|
| `budget` | prints the slice's draw on each account-wide quota at the tier, as JSON | run without credentials |
| `deploy` | deploys the slice's stacks, or reuses them | publish what the next slice needs through the sample's published parameters (P-2); the runner times it (P-6) |
| `seed` | creates the slice's data for the tier, or reuses the manifest | be safe to rerun; never write a token or a password to disk |
| `step <name>` | platform mode only: one named part of the slice's set-up or teardown that must run between another slice's verbs (§3.5) | be safe to rerun; a set-up step counts in the slice's deploy seconds, a step run before another slice's teardown in that slice's destroy seconds |
| `run <scenario>` | runs one scenario | write one result record per scenario (§4.3); exit non-zero on a pass-criterion failure |
| `collect` | reads logs and metrics for the run window | wait for late log delivery (runtime-isolation finding F-6); write the late fields (`refusals`, `cost`) into its own slice's records, only those nobody else changed since `run`; any other change after `run` fails the run |
| `teardown` | removes what the slice deployed | keep fixtures unless `--fixtures` is passed; verify nothing it owned is left; the runner times it (P-6) |

`slice.json` names the slice, the slices it needs (by published interface),
its scenarios, the scenarios only a platform run can run (`platformOnly`,
optional), the platform steps it implements (`steps`, optional), and the quotas
it draws on. A `platformOnly` scenario works on
what other slices made, such as the edge and the cells the control plane
built, so a slice-mode run leaves it out and refuses one named in
`--scenarios` (§3.5).

The runner orders slices by their needs. A slice-mode run deploys and then
seeds each slice in turn. A platform run follows the order of §3.5, which
interleaves the slices' `deploy` and `seed` verbs and their steps (stress
ADR-0018). `teardown` runs in the reverse order of the slices, with the
control plane's `unhook` step before the front door's teardown. The needs and
steps the four slices declare are:

| Slice | Needs | `platformOnly` scenarios | `steps` |
|---|---|---|---|
| `tenant-identity` | none | none | none |
| `control-plane` | `tenant-identity` | PS-5 | `hooks`, `register`, `warm-up`, `unhook` |
| `tenant-front-door` | `tenant-identity`, `control-plane` | none (PS-7 also runs in slice mode, on the smoke stack) | `phase-two` |
| `agentic-runtime-isolation` | `tenant-identity`, `control-plane`, `tenant-front-door` | PS-2, PS-3, PS-4, PS-6, PS-8 | none |

The `agentic-runtime-isolation` cells are deployed by the control plane in
the platform run, and by the slice itself when it runs alone. With one
slice named (slice mode) its needs are not required.

Inputs every verb reads from the environment:

| Variable | Meaning |
|---|---|
| `STRESS_TIER` | `small`, `medium` or `large` |
| `STRESS_RUN_ID` | one id per run, in every result record and log line the driver writes |
| `STRESS_PREFIX` | stack and resource name prefix |
| `STRESS_HOME` | the manifest folder outside the repository |
| `STRESS_MODE` | `slice` (alone) or `platform` (composed) |
| `STRESS_TIER_JSON` | the whole tier from `stress/src/tiers.ts`, as JSON |
| `STRESS_RESULTS` | the folder `run <scenario>` writes its record to |
| `STRESS_REPO` | the repository root |
| `STRESS_COMMIT` | the commit the run is built from |

`budget` runs without credentials: no `AWS_*` variable from the runner,
an empty `HOME`, and `AWS_EC2_METADATA_DISABLED=true`. Each verb runs in
its own session and process group with no stdin; SIGINT, SIGTERM or SIGHUP
to the runner reaches the whole group, and anything a verb leaves running
is stopped when it exits.

### 3.5 Runner

`stress/run.sh run --tier <tier> --slices <a,b,...> [--scenarios <x,y>] [--limits <file>] [--remove-fixtures]`:

1. Reads every named `slice.json` and refuses:
   a need that is no slice, and a need left out of `--slices`, when more
   than one slice is named (one slice named is slice mode, which does not
   check its needs); a cycle in the needs; a `--scenarios` entry that no
   named slice declares; a `platformOnly` scenario named in a slice-mode
   run, which has nothing to run against; and a run left with no
   scenario to run (a platform run with no `PS-<n>` scenario, a
   slice-mode run whose scenarios are all `platformOnly`).
2. Sums `budget` per account and refuses to start when a sum is over its
   quota or another run holds the lock for the prefix.
3. In slice mode runs `deploy` and then `seed` for one slice at a time, in
   the order of the needs (§3.4); a platform run follows the set-up table
   below instead (stress ADR-0018). Then the scenarios, then `collect`,
   then `teardown` in reverse order. Without `--scenarios`, a platform
   run (several slices) runs only the `PS-<n>` scenarios, by number (§5),
   and a slice-mode run runs the slice's scenarios except its
   `platformOnly` ones; `--scenarios` runs the scenarios named, in the
   order given. Teardown runs on failure and after SIGINT, SIGTERM or
   SIGHUP too.
4. Writes the run's result file (§4.3). Runner lines and all verb output
   go to `run.log` in the run folder, which only the runner's user can read.

With one slice named, the runner is that sample's stress test. With all
of them, it is the platform run. `--remove-fixtures` passes `--fixtures`
to every `teardown` (§3.4).

Teardown has one ordering rule that the reverse order alone does not
give. In the reverse order the front door goes before the control plane,
and the control plane's cell delete runs the front door's `PRE` hook
(`CELL_DELETE`, `DEPLOYMENT_DELETE`) against the route registrar. In the
platform run the control plane's step `unhook` therefore runs before the
`tenant-front-door` `teardown`: it unregisters the front door's two global
hooks (`register-hooks.sh --delete`, front-door spec §5.2) and takes the
hook policy out of `globalHookManagedPolicyArns` with a control-plane
update, so the control plane deletes deployments and cells with no call to
a registrar that is gone. The front door's `teardown` then refuses to
start while the policy is still attached, and removes `RouteHookAccess`
and its parameter, then the stacks; it verifies that none is left (§3.4).
In slice mode the front door runs on the smoke stack, where no hook is
registered on any control plane, so its `teardown` unregisters none.
Front-door spec §6.2 removes the routes through the hooks first and
unregisters the hooks last; here the registrar and the route table are
destroyed in the same teardown, so no route needs removing.

In the platform run the front door deploys in two phases, because its
`agentIngress` input is the first cell's ingress, which exists only
after the control plane builds that cell (stress ADR-0016). Phase one
is two deploys of the front-door app, the second with `registrarUrl`,
which adds the `RouteHookAccess` stack (front-door ADR-0027); the
control plane's `globalHookManagedPolicyArns` update and the hook
registration then put the route hook in place before that build: a
cell built with no hook has no cell route, and every deployment placed
in it fails its hook with 409 until an operator backfills the route
(front-door spec §3.2, §3.4). The platform run's set-up order is a table in
the runner (`stress/src/platform.ts`, stress ADR-0018); each row below is one
action of it:

| # | Step | Owned by |
|---|---|---|
| 0 | stress identity deployed, whose issuer the front door takes as its `issuer` input and every cell trusts | `tenant-identity` `deploy` |
| 1 | control plane and its vendor IdP deployed, with no application yet, the vendor IdP with an app client with a secret for the registrar, whose client-credentials tokens carry the reader role for that client only; that client's id in `vendorIdp.clientIds`, and `readerRoles`; the secret in Secrets Manager in the platform account and the token URL from the user-pool domain, both for the front door's `controlPlane` input (control-plane R-36, R-38; front-door spec §6.1); the connection (API, reader client) written to `control-plane-connection.json` | `control-plane` `deploy` |
| 2 | front-door phase one, first deploy: the edge stack, the main stack (distribution, router, route table, registrar) and the edge logging stack, with `applicationId` set to the stress application's id, `stress`, the value step 4 registers, with `issuer` naming the stress identity's app client (`identity.json`, §4.2; its other fields are Q-8), with `controlPlane`, `fleet` and `edgeOperatorRoleArn` set (front-door spec §3.6; the edge operator role is the role the `tenant-front-door` slice deploys with), and with `agentIngress` unset, so the edge refuses `/agents/*` (404, or CloudFront's own 403 for a `POST`, front-door spec §3.3 step 3) | `tenant-front-door` `deploy` |
| 3 | front-door phase one, second deploy: the same app with `registrarUrl`, read from the edge parameter, which adds the `RouteHookAccess` stack in the control plane's account (front-door ADR-0027); then the control plane's `globalHookManagedPolicyArns` update and the global hooks registered with the front door's `register-hooks.sh`, whose hook source is the front door's repository on GitHub (or a fork), pinned to `hookCommit` (§3.6), a full commit SHA that holds `samples/tenant-front-door/hooks/route-hook.sh` and that CodeBuild can fetch from the remote (front-door spec §5.2) | `tenant-front-door` `deploy`, then `control-plane` step `hooks` |
| 4 | the stress application registered, declaring a cell parameter whose `default` is the distribution ARN read from the edge parameter (control-plane R-34, ADR-0040); then the cell account registered for it, with `maxCells` 1 at `small`. The cell app passes the ARN to `CellRouteAccess` (front-door spec §5.2), so the cell account needs no front-door parameter and no stack beyond §3.7. Both answer 202, so the step waits until the application and the account are `ACTIVE` | `control-plane` step `register` |
| 5 | one warm-up tenant: its `CreateDeployment` builds the first cell, the hook registers the cell and tenant routes, and the step waits for the deployment and the cell to be `ACTIVE`, then records the tenant, the cell, its account, the cell API's domain and the ingress parameter in `control-plane.json` (`warmUp`); the tenant's identity and users and the readiness poll (§3.3 step 4) run at the start of PS-1, after step 6 | `control-plane` step `warm-up`; left out of PS-1's percentiles, timed apart as `warm-up-ready` (§5.1) |
| 6 | front-door phase two: a main-stack update with `agentIngress` set to that cell's ingress, `registrarUrl` kept | `tenant-front-door` step `phase-two` |
| 7 | the rest of the tier's onboarding (PS-1 at `buildLimit`), then the other scenarios | §5.1 |

The warm-up tenant goes alone because the control plane places a
deployment only into an `ACTIVE` cell, and a placement that arrives
while the only cell is `CREATING` claims a new cell slot (control-plane
§7.2, ADR-0013 as amended by ADR-0024). At `maxCells` 1 such a placement
is refused, so `small` keeps one cell and one `agentIngress`. Steps 2
to 6 alternate between two slices' verbs, which a runner that runs one
slice's `deploy` and `seed` before the next slice starts (item 3 of the
list in this section) does not express; the runner's platform table
interleaves them (stress ADR-0018).

Phase two takes the origin's domain and its path, the ingress stage,
from the ingress's published parameter,
`/application-plane/shared/agent-runtime/StressCell-<cellId>/ingress`
(`baseUrl`, front-door spec §6.3; the cell keeps
`publishParameters=false`, so the parameter is under the cell stack's own
prefix, stress ADR-0019), where `<cellId>` is the warm-up
tenant's cell, read from the control plane. The `tenant-front-door`
slice reads it with `ssm:GetParameter` on that one parameter, and
refuses a `baseUrl` that is not
`https://<id>.execute-api.<region>.amazonaws.com/<stage>`: a cell build
writes that parameter, and the value picks the host that receives every
tenant's bearer token on `/agents/*`. The check proves the form of the
host and not that the API is the cell's own (§3.7). The slice assumes
the ingress reader role (§3.6), a read-only role in the cell account's
account base (§3.7, W-11), with the platform account credentials it
deploys with. Phase two is a CloudFront distribution change in the main
stack, on every run at `small`. Its time is part of the front-door slice's
`deploySeconds` (P-6), and the slice logs it on a line of its own.

The lock is per prefix on the runner's host. A second run from another host
against the same accounts is not detected; one run per set of accounts at a
time is an operating rule (`stress/README.md`, known limitations).

### 3.6 Deployment inputs

| Input | Default | Meaning |
|---|---|---|
| platform account | none | one non-production, CDK-bootstrapped account for everything that is not a cell |
| cell accounts | none | one (`small`) or two (`medium`, `large`) standalone non-production accounts, as §3.7 requires |
| `appDomain` | none | a test subdomain with a public hosted zone in the platform account, for the front door |
| `buildLimit` | 50 | concurrent builds per control-plane CodeBuild project for the stress deployment (§8, decision 2). The limit applies to every CodeBuild project the control plane creates. The control plane creates four projects: the cell, the tenant, the global hook and the application hook project. The stress application declares no hooks of its own, so its builds run in the first two, plus the global hook project once the platform run registers the front door's route hook (§3.5). All four run in the platform account on `BUILD_GENERAL1_SMALL`, so the quota must hold 50 x 4 = 200 on that account's Linux/Small quota (the figure the control plane's synth warning prints), of which the run draws at most 100 in `slice` mode and 150 in `platform` mode. The service default for that size is 1, so the platform account raises it before the first run |
| `pinnedCommit` | the run's `main` commit | the commit the cell scripts deploy |
| `hookCommit` | none | a platform run: the full SHA of a commit in the public repository that holds `samples/tenant-front-door/hooks/route-hook.sh`, which the control plane's global hook project fetches and runs (`STRESS_HOOK_COMMIT`). It can differ from `pinnedCommit`, which is a commit of the run's own branch that need not be public |
| ingress reader role | none | the ARN of the read-only role in a cell account's account base that allows `ssm:GetParameter` on `/application-plane/shared/agent-runtime/StressCell-*/ingress` only (one per Region of the account); `ingressReaderRoleArn` of the account in the cell accounts file; the `tenant-front-door` slice assumes it for front-door phase two (§3.5) |

### 3.7 Cell accounts

A cell account holds only:

| Stack | What it is |
|---|---|
| `CDKToolkit-cell` | the cell bootstrap (§8, decision 7) |
| the role pair | `control-plane`'s `CellAccountStack`, deployed by the account owner as plain CloudFormation without a service role; its roles are on the default path `/` and carry no cell boundary |
| account base | the account owner's stacks, each with the stack tag `stress:part=account-base`, deployed without a service role and listed by stack ARN for the check (below) (one or more; the policies deploy first, since the cell bootstrap names the boundary): the cell execution policy and boundary, the API Gateway account's CloudWatch Logs role, the identity parameters a cell reads (`/application-plane/shared/identity/*`, naming the platform's issuer), and a read-only role, trusted by the platform account root, that allows `ssm:GetParameter` on the ingress parameter of the cell stacks only (§3.5, stress ADR-0019) |
| cells | the stacks the cell script deploys |

It has no default CDK bootstrap, no control plane, no driver host and no
stacks of other samples. The owner's stacks deploy with the CDK's legacy
synthesizer, which deploys an asset-free template inline with the
owner's credentials, so the account never needs the default bootstrap. The cell bootstrap and its boundary scope a cell
build's IAM writes to cell roles; the account boundary scopes everything
else. A compromised cell build can change any cell in its account, and
nothing else in it: the boundary also denies SSM writes to the owner's
identity and bootstrap parameters, so it cannot pick the issuer the next
cell trusts, and changes to the API Gateway account setting, so it cannot
repoint the owner's logs role. It can still give a cell role a trust to another
account (`iam:UpdateAssumeRolePolicy` on `role/cell/*`); that role stays
under the boundary, but it is a way in from outside, and a redeploy that
does not change the role leaves it. The check below reads each `/cell/`
role's trust policy and refuses one that names a principal outside the
account and the AWS services the cell uses.

At `small` the cell's ingress parameter also picks the edge's
`/agents/*` origin. Phase two checks that the `baseUrl` it reads has the
form of an API Gateway host (§3.5), which does not stop a compromised
cell build that points the parameter at an API Gateway it owns in
another account: that build can send every tenant's token at `small`
outside the account. This is a known limitation of the `small` platform
run.

The `control-plane` slice's `deploy` enforces the account check before
the first cell build: it lists the account's CloudFormation stacks in
every Region the run uses and refuses an account with any stack but the
four kinds above (`CDKToolkit-cell` and the role pair by name, the
account base by its tag together with no service role and a stack ARN
on the list the account owner gives the check (W-11; an ARN pins the
Region and the stack id, so the same name in another Region or a
recreated stack does not pass), cells by their service role, the cell
bootstrap's execution role), a stack whose service role is set and is
not the cell execution role, a `cdk-hnb659fds-*` role, a role pair on
`/cell/` or under either cell boundary, a role pair half holding a
policy its stack did not give it (a managed policy other than its owner
policy, `cell-build-policy` or `cell-tenant-build-policy` with the
owner's suffix, or an inline policy other than the stack's default one
with the control plane's SSM namespace actions on
`/application-plane/`), a role pair half whose trust is not the stack's
(one statement allowing `sts:AssumeRole` to the platform account,
conditioned on `aws:PrincipalArn` being the fleet's build role for that
half or its API role, and nothing else), or a `/cell/` role trusted from
outside (above). The stack list, `iam:ListRoles`, and for the role pair
`iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies` and
`iam:GetRolePolicy` give all of it.

## 4. Data model

### 4.1 Tiers (`stress/src/tiers.ts`)

| | `small` | `medium` | `large` |
|---|---|---|---|
| Cell accounts (plus the platform account) | 1 | 2 | 2 |
| Cells (`maxTenants`) | 1 (25) | 2 (110) | 4 (1,025) |
| Agents per cell | 2 | 5 | 25 |
| Tools per cell | 2 targets x 10 | 2 targets x 100 | 3 targets x 100 |
| Tenants seeded | 20 | 200 | 4,000 |
| Tenants active | 20 | 200 | 1,000 |
| Users per active tenant | 2 | 2 | 1 |
| Onboarding | every run | every run | once, as a fixture (P-5) |
| Churn per run | 5 | 20 | 100 |
| Steady rate | 10 rps | 100 rps | 500 rps |
| Peak rate | 40 rps | 300 rps | 1,000 rps |
| Scenario length | 1 min | 3 min | 10 min |
| Driver instance | `t3.large` | `c6i.xlarge` | `c6i.4xlarge` |

Each cell's `maxTenants` is its seeded share plus its share of the churn
count, so a churn create (PS-5) lands in a free slot of an existing cell and
times a tenant build, not a cell build.

Users per active tenant counts the admin that `CreateTenant` creates,
when the control-plane driver (§3.3 step 4) or the `tenant-identity`
`seed` creates the users: an active tenant has the admin and the tier's
count minus one further users, and a tenant that is not active has the
admin only (tenant-identity ADR-0042). The runtime-isolation slice's own
`seed`, in slice mode, creates the tier's count of users beyond its
admin.

The `large` row splits the runtime-isolation `large` tier over four cells:
100 agents in total, the same as the runtime-isolation `large` tier, so
the Runtime count does not grow. Per cell
the load is a quarter, so per-cell results are not compared with the
single-ingress runs; platform totals are.

### 4.2 Manifests

One file per slice or interface under `STRESS_HOME/<prefix>/`, outside the
repository, mode 0600 in a 0700 folder: tenant ids, user names, deployment
and cell ids, URLs, account ids, the tier and the commit. Never a token, a
password or a key. `seed` reuses what a manifest lists when it still exists
and creates only what is missing. A slice that finds a manifest missing or
unusable stops with a message that names the file, the slice that writes it
and, when the content is wrong, the field.

A platform run uses five manifests:

| File | Written by | Read by | Holds |
|---|---|---|---|
| `tenant-identity.json` | `tenant-identity` `seed` | the identity slice's own scenarios | `seeded[]`: `tenantId`, `name`, `admin` and `users[]`, each user as `{username, email}`; the platform's tenants are not in it |
| `identity.json` | `tenant-identity` `deploy` | `agentic-runtime-isolation`; `control-plane`, for the identity calls of §3.3 step 4; `tenant-front-door` (`deploy-platform.sh`, PS-7) | the value of the SSM parameter `/<prefix>/identity`: `region`, `apiUrl` (the execute-api URL of the platform API), `userPoolId`, `appClientId`; the issuer is `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` |
| `control-plane.json` | `control-plane` `seed`; its driver adds an `identity[]` entry for each identity it creates (§3.3 step 4) and its `warm-up` step adds `warmUp` | `agentic-runtime-isolation`; `tenant-front-door` (PS-7, phase two); `control-plane` (teardown) | tenant ids in `seeded[]` (the platform's steady set), `churn[]` and `extra[]`; the last two belong to the control-plane scenarios; `identity[]`: for each tenant whose identity the driver created (§3.3 step 4), `tenantId`, `admin` and `users[]` as in `tenant-identity.json`; `warmUp`: the warm-up `tenantId`, its `cellId` and `accountId`, `cellApiDomain` (the cell API's function URL host), `ingressReaderRoleArn` and `ingressParameter` |
| `control-plane-connection.json` | `control-plane` `deploy` | `tenant-front-door` | `region`, `accountId`, `fleet`, `applicationId`, `apiUrl` (the control plane API), `vendorIdp`: `tokenUrl`, `clientId` and `clientSecretArn` of the route registrar's reader client (the secret itself stays in Secrets Manager) |
| `tenant-front-door.json` | `tenant-front-door` `deploy` (phase one), rewritten by its step `phase-two` | `agentic-runtime-isolation`; `control-plane` (PS-5, the hook step, the application's distribution parameter) | `edgeUrl` (an https origin, no path); `registrarUrl` (the registrar's execute-api URL with its stage, for `UpdateTenantRouteStatus`); `agentBackend` (optional, default `default`); `appDomain`; `distributionArn`; `hookPolicyArn` (the `RouteHookAccess` policy); `operatorRoleArn`; `phase` (1 or 2); after phase two `agentIngressUrl` |

`agentic-runtime-isolation` also writes `platform/manifest.json` (the
tenants it drove) and `platform-tenants.json` (tenants it refused or
ignored, by id and reason: `no-identity-tenant`, `no-user`,
`not-in-control-plane`) in its own folder. It drives, in platform mode,
every tenant in `control-plane.json` `seeded` that has an admin user in
the `identity[]` of the same file (W-9), and builds that set when each
scenario starts, because the control plane onboards its tenants in PS-1,
after every `seed`. It stops when fewer than two tenants are usable. The
identity tenants the control-plane driver creates (§3.3 step 4) are not
in `tenant-identity.json`, which only that slice's `seed` writes; the
driver records them in `identity[]` (stress ADR-0017, W-9), and a
control-plane tenant with no entry is refused (`no-identity-tenant`).
The identity tenants outlive the deployments they were made for: the
control plane's `DeleteDeployment` does not remove them, and the
`tenant-identity` `teardown` removes only the tenants it seeded. So the
`control-plane` `teardown` deletes the identity tenants of every
deployment of the run that has one, and removes their `identity[]`
entries. Those are the seeded tenants of `small` and `medium` and, at
`large`, the churn tenants that PS-1 onboards and removes. The reverse
order of §3.4 runs this before `tenant-identity`'s teardown. The `large`
fleet is a fixture (P-5), and its identity tenants stay with it. With
`--remove-fixtures`, the `tenant-identity` `teardown` destroys the
stress identity's stack, which removes every identity tenant, so the
`control-plane` `teardown` makes no per-tenant call then. `DeleteTenant`
scans the whole pool in `shared-pool` (tenant-identity README), so the
time of the per-tenant deletes is a result.

### 4.3 Result records

One JSON record per slice per scenario, collected into
`stress/results/<date>-<tier>.md` (committed) with the raw k6 and log
exports outside the repository.

| Field | Holds |
|---|---|
| `runId`, `tier`, `slice`, `scenario`, `mode` | identity of the record |
| `commits` | the commit of each sample in the run |
| `window` | start and end, UTC |
| `deploySeconds`, `destroySeconds` | per slice (P-6) |
| `requests` | count by status and reason |
| `latency` | p50, p95, p99 per hop (§6) |
| `isolation` | assertions made, mismatches (P-1) |
| `quotas` | the peak draw on each budgeted quota, by account |
| `refusals` | 4xx and 5xx by tenant and reason; unattributed count (P-7) |
| `cost` | the run day's cost by service above a quiet day, by account |

### 4.4 Quota budget

Each slice's `budget` fills its column; the runner sums per account.

| Quota (per account) | `control-plane` | `tenant-identity` | `tenant-front-door` | `agentic-runtime-isolation` (per cell) |
|---|---|---|---|---|
| Lambda concurrency | API and workflow; in `platform` mode, in each cell account, the cell's cell API origin | platform and token functions | registrar | ingress, authoriser, tools |
| CodeBuild concurrent builds | `buildLimit` x the projects the run builds in (cell and tenant, plus the global hook project in `platform` mode); the control plane creates four, §3.6 | - | - | - |
| STS `AssumeRole` | role pair per build | - | - | TVM |
| KMS `Sign` | - | - | - | mint, tool contexts |
| API Gateway control plane | deploy | deploy | deploy | deploy, tenant keys |
| AgentCore Runtime sessions and TPS | - | - | - | agents |
| Cognito (stress pool) | groups (2 per tenant) and users of the identity tenants it creates (§3.3 step 4, W-9); the groups are budgeted in the `tenant-identity` column, the users by no slice | groups (2 per tenant, 10,000 cap), auth; in a platform run its budget counts the control plane's tenants too | - | - |
| CloudFront Functions compute, KVS size | - | - | router, route table | - |

The `control-plane` driver's identity calls (§3.3 step 4) also draw on
the Cognito user-write categories and on the platform API's stage
throttle. They have no id in the quota catalogue, so no slice books
them. The groups the identity tenants add are booked in the
`tenant-identity` column; the user writes and the throttle are not
(stress ADR-0017).

## 5. Scenarios

### 5.1 Platform scenarios

Run in this order in `platform` mode; a platform run runs these `PS-<n>`
scenarios by default (§3.5). The runner runs scenarios one after another,
so PS-5 runs on its own after PS-4 and PS-7 on its own after PS-6, with no
PS-2 load beside them. Agent calls go from the edge straight to the
ingress; at `small` that is the one cell's ingress (§3.3, stress
ADR-0016). Scenarios above `small` wait for Q-7. In PS-1 a tenant's `ready` time is
`CreateDeployment` to its first served `/api/whoami` through the edge (stress ADR-0020); a
tenant that was not placed in this run is timed apart as `rerun-ready`, and the warm-up
tenant as `warm-up-ready`, which holds its cell build and the set-up between the warm-up
step and PS-1, so it is not a cell build time.

| Id | Shape | What it stresses | Watch |
|---|---|---|---|
| PS-1 onboarding | the tier's onboarding at `buildLimit`; at `large`, where the fleet is a fixture, PS-1 is timed on the churn tenants it onboards and removes | control plane, CodeBuild, tenant scripts, tenant-identity platform throttle, registrar | deployments per minute; time from `CreateDeployment` to the first served request, which includes the route hook build and the tenant's identity calls (§3.3 step 4), those timed as hops of their own (§6), for every tenant but the warm-up tenant, which builds the cell before front-door phase two (§3.5); build failures by cause |
| PS-2 steady through the edge | runtime-isolation S1 shape through CloudFront to the cell's ingress | every hop of the agent path (§3.3) | latency per hop; edge overhead; router compute utilisation |
| PS-3 herd through the edge | S2 shape: ingress instances in the cell, 0 to the peak rate in 5 s; it reuses the conversations PS-2 opens in the same run, so it runs after PS-2. In platform mode the slice has no write access to the cell accounts and cannot retire the instances, so it waits 60 s idle and starts the herd there: the cold-start share is what the instances' age allows | cold starts behind the edge, per-account quotas | refusals by tenant; STS and Lambda throttles by account |
| PS-4 noisy neighbour | S3 shape: one tenant at 10x its limit | the per-tenant limit behind the edge: the ingress's own for agent calls | that tenant refused; every other tenant on its cell served |
| PS-5 churn | after PS-4: create, suspend, resume and delete the churn count of tenants, each timed from its call to the first edge answer that shows it. The edge is read with an unsigned token that names the tenant, which the router accepts without checking the signature (front-door spec §3.3 step 5): the router's own answer, the body `{"status":403}`, means no route and `{"status":503}` means suspended. An answer that carries API Gateway's request id, the ingress's own 403 for this token included, means the router passed the request on to an origin. Any other answer tells nothing: CloudFront's own 403 or 503, a 404, or no answer. Suspend and resume are `UpdateTenantRouteStatus` calls to the route registrar, signed with the session's credentials, so the session holds the registrar's edge operator role | control-plane writes reaching the edge and the cells | time to routable; time to suspended (503 at the edge); time to removed (403 at the edge); no request for a removed tenant at an origin, which needs the edge's and the cells' logs joined |
| PS-6 long streams | S5 shape through CloudFront to the ingress, with nothing between the edge and the ingress | streaming through the edge | first byte at the client against first byte at the ingress; broken streams |
| PS-7 cross-cell probes | after PS-6: a token whose payload names another tenant (in another cell when the tier has more than one), a client route header, a direct `/api/*` call to a cell origin, a direct call to the ingress with a token whose payload names another tenant, and a direct call to the ingress with the tenant's own token | the router, the route hint check, origin access control, the ingress's own token check | every probe but the last refused at the edge, the cell, the origin or the ingress, never served; the last is served, because the ingress is public by design (front-door spec §1.2) |
| PS-8 peak | S6 shape at the tier's peak for 60 s | the shared quotas at their limit | the first quota that gives out, per account; every refusal attributed |

Each platform scenario is declared in the `slice.json` of the slice or
slices that own it, and each of them writes its own record:

| Scenarios | Owner slice | In `platformOnly` |
|---|---|---|
| PS-1 | `control-plane` and `tenant-identity`, each with its own record | no |
| PS-2, PS-3, PS-4, PS-6, PS-8 | `agentic-runtime-isolation`: its S1, S2, S3, S5 and S6 load shapes sent to `<edgeUrl>/agents/<agent>/invocations` | yes |
| PS-5 | `control-plane` | yes |
| PS-7 | `tenant-front-door` (W-7) | no (it also runs in slice mode, on the smoke stack) |

### 5.2 Slice scenarios

Each slice keeps scenarios of its own for `slice` mode:

| Slice | Scenarios |
|---|---|
| `agentic-runtime-isolation` | S1 to S7, as in its stress-test plan |
| `control-plane` | placement races (many `CreateDeployment` on one nearly full cell), read rate (`ListDeployments`, `ListCells` under writes), build-limit scaling (onboarding rate at 5, 20 and 50) |
| `tenant-identity` | token issue and refresh rate against the platform and `/oauth2/token` throttles; `CreateTenant` under Cognito throttling (runtime-isolation finding F-3) |
| `tenant-front-door` | route write rate and time to edge; router compute with large tokens; edge refusals with no origin call |

### 5.3 Isolation assertions

Every request through the edge checks the layers its path crosses (P-1):

| Layer | Path | Check | Failure means |
|---|---|---|---|
| Edge | `/api/*` | the response's route hint names the token's tenant | the router routed on something other than the token |
| Cell | `/api/*` | the cell account lists the tenant, and the answer's cell id is the tenant's placed cell | a tenant reached a cell that does not host it |
| Ingress and agent | `/agents/*` | `tokenTenant` and the unit prefix are the tenant's | the wrong grant or unit reached the Runtime |
| Credential | `/agents/*` | `read <A>` succeeds, `read <B>` is `AccessDeniedException` | the vended credential is not scoped |

Limitation: on `/agents/*` the edge check is limited. The router sets the
route hint on the request, but the ingress does not echo it, so the
driver cannot read which tenant the edge routed for. On this path the
edge picks no per-tenant origin, and the ingress takes the tenant from
the verified token, so an edge fault can only admit or refuse the wrong
request. The run sees that through each request's status (`refusals`,
P-7) and PS-5: a suspended tenant gets 503 and a removed one 403 at the
edge, and no request for a removed tenant appears in the ingress log.
The agent path asserts the token's tenant at the ingress and the
credential check. The change that removes the limit is an ingress that
echoes the route hint it received (stress ADR-0016).

The `/api/*` rows need a cell API origin that echoes the hint. The
stress cell has one in any case: the front door writes a tenant route
only for a cell whose route names the API domain from the cell script's
`frontDoorApiDomain` output (front-door spec §3.2, §3.4), so the cell
script deploys a cell API origin and writes that output (§3.3 step 2,
W-5). The platform's load is agent calls, so the `/api/*` rows are made
on the one `/api/*` call per tenant at onboarding (§3.3 step 4) and on
the PS-7 probes, not under the load scenarios PS-2, PS-3, PS-4, PS-6 and
PS-8.

## 6. Observability

Latency is measured per hop with one correlation id per request: the driver
sends `x-correlation-id`, and each hop logs it (stress ADR-0005).

| Hop | Source |
|---|---|
| Client to edge | k6 timings |
| Router | CloudFront Functions `FunctionComputeUtilization`; the router's log line |
| Edge to origin | CloudFront real-time or standard logs (`time-taken`, origin latency); the origin is the ingress for agent calls and the cell origin for `/api/*` |
| Cell origin | the origin's log line (`/api/*` only) |
| Ingress, Runtime, tools | runtime-isolation `request served` and `tool admitted` lines |
| Onboarding | control-plane deployment status times; CodeBuild build durations; the driver's identity calls (§3.3 step 4), each timed from its call to its answer, with the time the call waited for the driver's pace apart (W-9) |

Edge overhead is client TTFB minus ingress TTFB, per request, joined on the
correlation id.

A live and after-the-run view of these figures on one CloudWatch dashboard is
described in [`docs/stress-dashboard.design.md`](./stress-dashboard.design.md)
(stress ADR-0022, Accepted; built as W-12, see `stress/dashboard/README.md`). It
decides no pass criterion.

## 7. Pass criteria

| Criterion | Pass |
|---|---|
| Isolation | 0 mismatches over the run, at every layer of §5.3 |
| Attribution | 0 unattributed refusals (P-7) |
| Churn | a removed tenant never reaches an origin; time to routable and time to removed reported with p50 and p99 |
| Edge overhead | reported with p50 and p95; no target until the first `medium` run sets a baseline |
| Teardown | nothing a slice owned left in any account, apart from fixtures |
| Budget | no budgeted quota exceeded except in PS-8, where it is the result |

## 8. Decisions

| # | Decision | Why it needs an ADR | ADR |
|---|---|---|---|
| 1 | The shared contract lives in `stress/` at the repository root, with its ADRs in `stress/adr/` | the sample standard has no root folder for code shared across samples | stress ADR-0001 |
| 2 | `control-plane` exposes the concurrent build limit as a prop (default 5) | a cost guard (threat model T16, M17); the stress deployment raises it | control-plane ADR-0046 |
| 3 | The stress test has its own `tenant-identity` deployment | one pool caps at 5,000 tenants (runtime-isolation finding F-11) and is shared by every integration run | stress ADR-0002 |
| 4 | Cells split agents (four cells of 25 at `large`) | keeps the Runtime count flat while testing routing across cells | stress ADR-0003 |
| 5 | The `large` fleet is a fixture, seeded once | onboarding 4,000 tenants takes hours even at 50 builds | stress ADR-0004, stress ADR-0021 |
| 6 | A correlation header, logged at every hop | the runtime-isolation ingress and the front door each log it; a change to both samples | stress ADR-0005 |
| 7 | The cell script deploys runtime-isolation with the CDK from a pinned commit, through the account's role pair and a scoped cell bootstrap | the cell build would otherwise act as an account administrator; see below | stress ADR-0006, stress ADR-0011, stress ADR-0012, stress ADR-0014, stress ADR-0016, control-plane ADR-0047 |
| 8 | The runtime-isolation `StressDriver` and k6 library move to `stress/` | they become the shared driver; its slice keeps only its own scenarios | stress ADR-0007 |
| 9 | At `small`, the front door's one `agentIngress` is the one cell's ingress; per-cell agent routing for `medium` and `large` is Q-7 | the front door routes only `/api/*` per cell, so agent calls cannot reach a per-cell ingress through the router | stress ADR-0016 |
| 10 | The driver of the `control-plane` slice creates each onboarded tenant's identity tenant and users, through the IAM-signed platform API of the stress identity; the tenant script keeps only the entitlement call | three components could do it, and the choice sets what PS-1 times and which role may call the identity's platform API | stress ADR-0017 |
| 11 | The runner owns the platform set-up order, and a slice implements the steps of it as `slice.sh step <name>` | the set-up of four slices is a cycle that one `deploy` and one `seed` per slice cannot express | stress ADR-0018 |
| 12 | The stress cell deploys the front door's cell API origin, and the platform account reads the cell's ingress parameter with a reader role in the account base | the route hook needs a cell route, and phase two needs the ingress URL, which the control plane does not return | stress ADR-0019 |
| 13 | PS-1 times a tenant to its first served `/api/whoami`, with the warm-up tenant timed apart | the agent path is not open for the first tenant, and a model call per tenant is not the onboarding | stress ADR-0020 |

Decision 7, the cell bootstrap. A `cdk deploy` needs `sts:AssumeRole` on
the account's CDK bootstrap roles. Each cell account carries one bootstrap,
for cells only, whose execution role carries the cell permissions boundary
and every role a cell creates the cell workload boundary (stress ADR-0011).
The policies, the `/cell/` aspect and the scripts ship in
`stress/application/` (W-10):

| Part | Value |
|---|---|
| Bootstrap | `cdk bootstrap --qualifier cell --toolkit-stack-name CDKToolkit-cell --cloudformation-execution-policies <cell execution policy ARN> --custom-permissions-boundary cell-permissions-boundary`, run once by the account owner |
| Cell roles | every role a cell creates is on the IAM path `/cell/`; the stress application's cell app sets it with `CellRolePath` (`stress/application/cell-path.ts`), a CDK aspect that matches every `CfnResource` of type `AWS::IAM::Role` (custom resource provider roles are not `CfnRole`) and sets `Path` with a property override |
| Cell execution policy | `cell-execution-policy` (`stress/application/cell-policies.ts`): API Gateway, Application Auto Scaling (a DynamoDB global table deregisters its scalable targets on delete), AgentCore, CloudWatch, DynamoDB, KMS, Lambda, CloudWatch Logs, SSM, IAM read (`iam:Get*`, `iam:List*`), read of `cdk-cell-assets-*`, IAM role writes on `role/cell/*` only, `iam:CreateRole` and `iam:PutRolePermissionsBoundary` only with the cell workload boundary, `iam:PassRole` on `role/cell/*` only when `iam:PassedToService` is `lambda.amazonaws.com` or `bedrock-agentcore.amazonaws.com`, and `iam:CreateServiceLinkedRole` on `role/aws-service-role/*` only when `iam:AWSServiceName` is `ops.apigateway.amazonaws.com` and `runtime-identity.bedrock-agentcore.amazonaws.com`, whose trust IAM fixes to the service |
| Cell permissions boundary | `cell-permissions-boundary`, on the execution role: the same services and IAM read, IAM role writes on `role/cell/*`, and the same `iam:PassRole` and `iam:CreateServiceLinkedRole` allows as the execution policy; it holds no run-time call and no `sts:AssumeRole`; it denies `iam:CreateRole` and `iam:PutRolePermissionsBoundary` unless the boundary is the cell workload boundary, any IAM role write, `iam:PassRole` or `sts:AssumeRole` on a role outside `/cell/` (the deny's `NotResource` is `role/cell/*`), `iam:PassRole` to any service but Lambda and AgentCore, `iam:CreateServiceLinkedRole` for any other service, Lambda function URLs with `AuthType NONE`, removing a boundary, users, access keys, policy writes, SSM writes to the account owner's parameters (`/application-plane/shared/identity/*`, `/cdk-bootstrap/cell/*`), and changes to the API Gateway account setting (`apigateway:PATCH`, `PUT`, `DELETE` on `/account`) |
| Cell workload boundary | `cell-workload-boundary`, on every role a cell creates (stress ADR-0011): the run-time services (AgentCore, the Bedrock model calls, CloudWatch, DynamoDB, `execute-api`, KMS, Lambda, CloudWatch Logs, SSM, `sts:TagSession`, `sts:GetCallerIdentity`, X-Ray), read of `cdk-cell-assets-*`, and `sts:AssumeRole` on `role/cell/*` only; it denies every IAM action, `sts:AssumeRole` outside `/cell/`, resource-policy and sharing writes (Lambda permissions and function URLs, KMS key policies and grants, CloudWatch Logs resource policies, subscriptions, destinations, account policies, log deliveries and export tasks, DynamoDB resource policies and table exports, SSM, AgentCore and X-Ray resource policies), Lambda function URLs with `AuthType NONE`, SSM writes to the owner's parameters and changes to the API Gateway account setting |
| Cell synth | `@aws-cdk/core:bootstrapQualifier` `cell` and `@aws-cdk/core:permissionsBoundary` `{"name":"cell-workload-boundary"}` as object context (`cellSynthContext` in `stress/application/cell-path.ts`, `cdk.json` or `CDK_CONTEXT_JSON`); a CLI `--context` passes the boundary as a string, which the CDK ignores |
| Role pair | `control-plane`'s `cellBuildManagedPolicyArns` (ADR-0047); the cell account owner attaches `cell-build-policy`, which allows `sts:AssumeRole` on the deploy, file-publishing and image-publishing `cdk-cell-*` roles of its own account and Region, and nothing else (not the lookup role, which holds `ReadOnlyAccess` without the boundary) |

Three walls hold the scope together. The two boundaries keep the execution
role and every cell role under them, and no role a cell creates holds an
IAM permission. The `/cell/` path keeps cell roles and the execution role
from writing to, passing or assuming any role that is not a cell role: the
account's own administrator roles, the role pair and the bootstrap roles.
The standalone account (§3.7) leaves no other stack or data for the service
grants to reach. The boundary spike (`stress/spikes/cell-boundary/`)
proved the boundary wall. The path spike (`stress/spikes/cell-path/`)
proved the path wall in two standalone cell accounts: 18 escalation
probes refused by an explicit deny in the boundary in each (IAM, policy
versions, a boundary swap, SSM writes to the owner's parameters, and the
API Gateway account setting), and
a runtime-isolation cell
deployed with 27 of 27 roles on `/cell/`. The shipped policies in
`stress/application/` ran `probes.sh` in both cell accounts, as the
execution role's stand-in and as a cell role under the workload boundary
(`stress/application/README.md`). The request path in a cell account is
Q-5, answered by the first platform run at `small` (`stress/results/2026-11-21-small.md`).

## 9. Work items and parallel readiness

| Work item | Needs | Ready to build in parallel |
|---|---|---|
| W-1 contract: `tiers.ts`, result schema, budget, runner | decision 1 | done in `stress/` |
| W-2 driver and k6 library moved to `stress/` | W-1 schema | done in `stress/driver/` and `stress/k6/` |
| W-3 runtime-isolation slice on the contract | W-1, W-2 | done in `samples/agentic-runtime-isolation/scripts/stress/` |
| W-4 control-plane build-limit prop | decision 2 | done: control-plane ADR-0046 |
| W-5 control-plane slice and the stress application, with the stress cell's cell API origin, its `frontDoorApiDomain` output and the distribution ARN cell parameter (§3.3 step 2, §3.5) | W-1, W-4, W-10; W-11 for Q-1 and the account check | the slice in `samples/control-plane/scripts/stress/`, the stress application and the role pair in `stress/application/` (stress ADR-0012 to ADR-0015) are done; Q-1 answered; the cell API origin, the output and the cell parameter are done in W-9 (`stress/application/cell-app.ts`) |
| W-10 `cellBuildManagedPolicyArns` prop; cell execution policy, permissions boundary, workload boundary, `/cell/` path aspect and the cell bootstrap, in `stress/application/` | decision 7; the deny probes ran in the path spike (`stress/spikes/cell-path/`); the second boundary is ADR-0011 | done: the prop in control-plane ADR-0047, the rest in `stress/application/` |
| W-11 two standalone cell accounts, bootstrapped with the cell bootstrap and the role pair, and a read-only role in the account base that allows `ssm:GetParameter` on the ingress parameter only, for front-door phase two (§3.5) | §3.7; W-10's policies and prop for the bootstrap and the role pair | done in both cell accounts: the owner stacks, `CDKToolkit-cell` and the role pair (`stress/application/deploy-role-pair.sh`, W-5); the account check passes on both; the ingress reader role is done in W-9 (`CellAccountBaseStack` in `stress/application/cell-account.cdk.ts`) |
| W-6 tenant-identity slice and stress identity fixture | W-1, decision 3 | done in `samples/tenant-identity/scripts/stress/` |
| W-7 front-door slice | the front door merged; its spikes S-2, S-3, S-5, S-7 passed; W-1; W-11's ingress reader role for phase two in the platform run | done |
| W-8 correlation header in the ingress and the front door | decision 6 | ingress part done; front-door part yes, now |
| W-9 first platform run at `small`: also the control-plane driver's identity calls (§3.3 step 4) and the record of them that the runtime-isolation slice reads (§4.2), the cleanup of those identity tenants in the `control-plane` teardown (§4.2), and a check that the front door's hooks are unregistered (the control plane's step `unhook`, before the front door's teardown) before the control plane deletes cells (§3.5) | W-3, W-5, W-6, W-7, W-8, W-11; the platform set-up order in the runner (§3.5) | done (`stress/results/2026-11-21-small.md`) |
| W-12 a CloudWatch dashboard of a platform run, built as `stress/dashboard/`, the runner's emitter and the relay (stress ADR-0022, `docs/stress-dashboard.design.md` §12) | ADR-0022 accepted | built; see `stress/dashboard/README.md` for what ran live and what did not |

## 10. Open questions

| # | Question | Needed by |
|---|---|---|
| Q-1 | How long does one cell take to deploy from a CodeBuild cell script (expected about 8 minutes on Runtime V2), and does `BUILD_GENERAL1_SMALL` (3 GB) hold the synth? | Answered: a cell takes 486 s from `CreateDeployment` to the cell `ACTIVE`; inside the cell build the install takes 20 s, the synth 10 s and the deploy 421 s. `BUILD_GENERAL1_SMALL` holds the synth: the container has 3,831 MiB and 2 vCPUs and peaks at 1,977 MiB (`stress/application/README.md`, Results, run `20261120T142632Z`). In the first platform run (W-9, `stress/results/2026-11-21-small.md`), whose cell also deploys the cell API origin (stress ADR-0019), the cell took 617 s from CREATING to ACTIVE and its first tenant was ACTIVE 759 s after `CreateDeployment` (599 s and 757 s in the failed run before it); these are not the same interval as the 486 s |
| Q-2 | Does the front door's integration test compose runtime-isolation for `/agents/*`? Answered no: its test runs the agent route against a stand-in ingress (front-door ADR-0024), so the first platform run at `small` is the first to drive the real ingress through the edge | W-7; the W-9 run did (PS-2 to PS-8 through the edge to the cell's ingress) |
| Q-3 | Does the platform run keep the `large` fleet in every account between runs, and what does it cost idle? | decision 5 |
| Q-4 | Which hosted zone does the stress front door use? | W-7 |
| Q-5 | Does the request path work in a standalone cell account with every role on `/cell/` (authoriser, TVM `sts:AssumeRole` of a `/cell/` tenant role, the model call, tools)? Proven by the first platform run at `small` | Answered yes (run 2026-11-21, `stress/results/2026-11-21-small.md`): through the edge, the router, the ingress in the cell account and the authoriser, the TVM `sts:AssumeRole` of a `/cell/` tenant role, the agent's own-tenant and other-tenant reads and its streamed answers (PS-6, 301 of 301, p95 10.4 s) were served with 0 isolation mismatches in about 5,000 assertions, no unattributed refusal. The record does not count tool calls or model usage events apart, so the tool leg is not shown separately |
| Q-6 | Does runtime-isolation's package entry export what the stress cell app needs (`RuntimeIsolationDemoStack`, `parseDemoContext`, `bundleAgent`)? The path spike imports them from `src/` by path | W-5 kept the path imports: `stress/application/cell-app.ts` loads them from the sample's `src/` with the sample's own CDK; an export is not needed for the stress test |
| Q-7 | How do agent calls reach a per-cell ingress at `medium` and `large`, where there is more than one cell and the front door has one `agentIngress` (stress ADR-0016)? Candidates: (a) agent calls sent under `/api/*` to a per-cell origin Lambda in each stress cell, behind origin access control, that forwards to its ingress: no router change, but a different client path, the bearer mapped back from `x-tenant-token`, an extra hop, and response streaming for PS-6; (b) a front-door change for per-cell agent origins. Decided by a new stress ADR | before the first `medium` run |
| Q-8 | What does the front door's `issuer` input hold in the stress run? It takes the SPA's client id and scopes and either a Cognito domain or the authorize, token and logout endpoints (front-door spec §3.6). The stress identity has no Cognito domain and the run signs nobody in through the SPA; `identity.json` supplies the client id only | W-7 |
