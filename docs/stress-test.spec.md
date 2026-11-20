<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: specification

- Status: Accepted
- Date: 2026-11-18
- Scope: four samples composed as one agent platform: `control-plane`,
  `tenant-identity`, `tenant-front-door` (once merged) and
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
| Do tenants that are added, suspended or removed during load reach the right place, and how soon? | churn is a control-plane write that the edge and the ingress must both see |

A fourth question is a side effect of composition: the samples share
account-wide quotas (Lambda concurrency, STS, KMS, CodeBuild, the API
Gateway control plane). The per-sample runs never draw on them together.

Deployment model: pool at the edge and in identity; cells behind the edge,
in cell accounts that hold nothing but cells, each cell a pooled
runtime-isolation deployment for up to `maxTenants` tenants.

### 1.1 What the test shows

- Onboarding rate and time to ready, from `CreateDeployment` to the first
  served request through the edge.
- Latency per hop under load: edge, router, cell origin, ingress, Runtime,
  tools.
- Isolation under load end to end: every request checks the tenant at the
  edge, at the cell, at the ingress and at the vended credential.
- Churn under load: route updates seen at the edge within a measured time;
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
- Several Regions.
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
churn slice under load.

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
| Stress application | `stress/application/` | a control-plane application whose cell scripts deploy one runtime-isolation cell and whose tenant scripts onboard one tenant (§3.3) |
| Slice: `control-plane` | `samples/control-plane/scripts/stress/` | deploy the control plane, register accounts and the stress application, onboarding and churn scenarios |
| Slice: `tenant-identity` | `samples/tenant-identity/scripts/stress/` | the platform's identity deployment, token issue and refresh scenarios |
| Slice: `tenant-front-door` | `samples/tenant-front-door/scripts/stress/` | the edge, route writes, edge scenarios |
| Slice: `agentic-runtime-isolation` | `samples/agentic-runtime-isolation/scripts/stress/` (exists) | the cell's ingress, agents and tools; scenarios S1 to S7 |
| Fixture: stress identity | the platform account | a `tenant-identity` `shared-pool` deployment for the stress test only, so 4,000 stress tenants never crowd the pool every integration run shares |
| Fixture: fleet | every account | at `large`, the seeded tenants, deployments, cells and routes, kept between runs (P-5) |
| Platform account | a non-production account | the control plane, the edge, the route registrar, the stress identity and the driver host; never a cell |
| Cell accounts | one or two standalone non-production accounts | registered with the control plane; hold only the cell bootstrap, the role pair and cells (§3.7) |

### 3.2 Topology

```
                 ┌────────── platform account ──────────────────────────────┐
 driver host ───►│ CloudFront distribution ─► tenant router (KVS lookup)    │
 (k6)            │ control plane ─► CodeBuild ─► cell and tenant scripts    │
                 │ stress identity (tenant-identity shared pool)            │
                 │ route registrar                                          │
                 └──────┬──────────────────────────────────────┬────────────┘
                        │ cross-account origin, role pair      │
          ┌─────────────▼── cell account A ──────┐   ┌─────────▼── cell account B ──────┐
          │ cell A1 ─► runtime-isolation ingress │   │ cell B1 ─► runtime-isolation     │
          │ cell A2 ─► runtime-isolation ingress │   │ cell B2 ─► runtime-isolation     │
          └──────────────────────────────────────┘   └──────────────────────────────────┘
```

Every cell trusts the same issuer, the stress identity. The front door's
edge stack is in `us-east-1`, as its specification requires; everything
else is in `eu-central-1`. The driver host sits in the platform account,
so it never shares an account with a cell build.

### 3.3 Paths

**Onboarding** (one tenant, through the control plane):

1. The driver calls control-plane `CreateTenant`, then `CreateDeployment`
   for the stress application.
2. The control plane places the deployment. If the cell is new, its cell
   script runs first: it deploys one runtime-isolation cell (ingress,
   agents, tool targets) from the repository at a pinned commit, and
   registers the cell route with the route registrar.
3. The tenant script runs: tenant-identity `CreateTenant` with the
   control-plane tenant id, `PutTenantSubscription` on the cell ingress's
   Entitlements API, `PutTenantRoute` on the route registrar.
4. The driver creates the tenant's users with tenant-identity `CreateUser`
   and polls through the edge until the first `report` is served.

**Request** (one prompt):

```
k6 ─► CloudFront ─► tenant router ─► cell origin ─► ingress authoriser
   ─► TVM ─► Runtime agent ─► tools gateway ─► tool
```

The router reads the tenant from the token and sets the route hint; the
cell checks the hint against the verified token; the ingress takes the
tenant from the token; the agent reports the tenant on its transaction
token and on its vended credential.

**Churn** (during load): `CreateDeployment`, `UpdateTenantRouteStatus` to
suspended and back, and `DeleteDeployment`, each on a tenant the steady
load does not use, each timed from the call to the first edge response
that shows it.

### 3.4 Slice contract

A slice is one executable, `scripts/stress/slice.sh`, in its sample, plus
a declaration, `scripts/stress/slice.json`.

| Verb | Does | Must |
|---|---|---|
| `budget` | prints the slice's draw on each account-wide quota at the tier, as JSON | run without credentials |
| `deploy` | deploys the slice's stacks, or reuses them | publish what the next slice needs through the sample's published parameters (P-2); the runner times it (P-6) |
| `seed` | creates the slice's data for the tier, or reuses the manifest | be safe to rerun; never write a token or a password to disk |
| `run <scenario>` | runs one scenario | write one result record per scenario (§4.3); exit non-zero on a pass-criterion failure |
| `collect` | reads logs and metrics for the run window | wait for late log delivery (runtime-isolation finding F-6); write the late fields (`refusals`, `cost`) into its own slice's records, only those nobody else changed since `run`; any other change after `run` fails the run |
| `teardown` | removes what the slice deployed | keep fixtures unless `--fixtures` is passed; verify nothing it owned is left; the runner times it (P-6) |

`slice.json` names the slice, the slices it needs (by published interface),
its scenarios, and the quotas it draws on. The runner orders slices by
these needs: `tenant-identity`, `control-plane`, `tenant-front-door`, then
`agentic-runtime-isolation` cells (deployed by the control plane in the
platform run, by the slice itself when it runs alone).

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

`stress/run.sh run --tier <tier> --slices <a,b,...> [--scenarios <x,y>] [--limits <file>]`:

1. Reads every named `slice.json`, checks the needs are present, and
   refuses a `--scenarios` entry that no named slice declares.
2. Sums `budget` per account and refuses to start when a sum is over its
   quota or another run holds the lock for the prefix.
3. Runs `deploy` and `seed` in dependency order, then the scenarios in the
   order of §5, then `collect`, then `teardown` in reverse order. Teardown
   runs on failure and after SIGINT, SIGTERM or SIGHUP too.
4. Writes the run's result file (§4.3). Runner lines and all verb output
   go to `run.log` in the run folder, which only the runner's user can read.

With one slice named, the runner is that sample's stress test. With all of
them, it is the platform run.

The lock is per prefix on the runner's host. A second run from another host
against the same accounts is not detected; one run per set of accounts at a
time is an operating rule (`stress/README.md`, known limitations).

### 3.6 Deployment inputs

| Input | Default | Meaning |
|---|---|---|
| platform account | none | one non-production, CDK-bootstrapped account for everything that is not a cell |
| cell accounts | none | one (`small`) or two (`medium`, `large`) standalone non-production accounts, as §3.7 requires |
| `appDomain` | none | a test subdomain with a public hosted zone in the platform account, for the front door |
| `buildLimit` | 50 | concurrent builds per control-plane CodeBuild project for the stress deployment (§8, decision 2). The limit applies to every CodeBuild project the control plane creates. The stress application declares no hooks, so there are two, the cell and the tenant project. Both run in the platform account on `BUILD_GENERAL1_SMALL`, so 50 each draws 100 on that account's Linux/Small quota. The service default for that size is 1, so the platform account raises it before the first run |
| `pinnedCommit` | the run's `main` commit | the commit the cell scripts deploy |

### 3.7 Cell accounts

A cell account holds only:

| Stack | What it is |
|---|---|
| `CDKToolkit-cell` | the cell bootstrap (§8, decision 7) |
| the role pair | `control-plane`'s `CellAccountStack`, deployed by the account owner as plain CloudFormation without a service role; its roles are on the default path `/` and carry no cell boundary |
| account base | the account owner's stacks, each with the stack tag `stress:part=account-base`, deployed without a service role and listed by stack ARN for the check (below) (one or more; the policies deploy first, since the cell bootstrap names the boundary): the cell execution policy and boundary, the API Gateway account's CloudWatch Logs role, and the identity parameters a cell reads (`/application-plane/shared/identity/*`, naming the platform's issuer) |
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

The `control-plane` slice's `deploy` enforces it before the first cell
build: it lists the account's CloudFormation stacks in every Region the run
uses and refuses an account with any stack but the four kinds above
(`CDKToolkit-cell` and the role pair by name, the account base by its
tag together with no service role and a stack ARN on the list the
account owner gives the check (W-11; an ARN pins the Region and the
stack id, so the same name in another Region or a recreated stack does
not pass), cells by their service role, the
cell bootstrap's execution role), a
stack whose service role is set and is not the cell execution role, a
`cdk-hnb659fds-*` role, a role pair on `/cell/` or under either cell
boundary, a role pair half holding a policy its stack did not give it (a
managed policy other than its owner policy, `cell-build-policy` or
`cell-tenant-build-policy` with the owner's suffix, or an inline policy
other than the stack's default one with the control plane's SSM namespace
actions on `/application-plane/`), a role pair half whose trust is not the
stack's (one statement allowing `sts:AssumeRole` to the platform account,
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

The `large` row splits the runtime-isolation `large` tier over four cells:
100 agents in total, the same as the runtime-isolation `large` tier, so
the Runtime count does not grow. Per cell
the load is a quarter, so per-cell results are not compared with the
single-ingress runs; platform totals are.

### 4.2 Manifests

One file per slice under `STRESS_HOME/<prefix>/`, outside the repository:
tenant ids, user names, deployment and cell ids, account ids, the tier and
the commit. Never a token, a password or a key. `seed` reuses what a
manifest lists when it still exists and creates only what is missing.

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
| Lambda concurrency | API and workflow | platform and token functions | registrar | ingress, authoriser, tools |
| CodeBuild concurrent builds | `buildLimit` x the control plane's projects (2: cell and tenant, no hooks) | - | - | - |
| STS `AssumeRole` | role pair per build | - | registrar placement check | TVM |
| KMS `Sign` | - | - | - | mint, tool contexts |
| API Gateway control plane | deploy | deploy | deploy | deploy, tenant keys |
| AgentCore Runtime sessions and TPS | - | - | - | agents |
| Cognito (stress pool) | - | groups (2 per tenant, 10,000 cap), auth | - | - |
| CloudFront Functions compute, KVS size | - | - | router, route table | - |

## 5. Scenarios

### 5.1 Platform scenarios

Run in this order in `platform` mode. PS-5 and PS-7 run inside PS-2.

| Id | Shape | What it stresses | Watch |
|---|---|---|---|
| PS-1 onboarding | the tier's onboarding at `buildLimit`; at `large`, where the fleet is a fixture, PS-1 is timed on PS-5's creates | control plane, CodeBuild, tenant scripts, tenant-identity platform throttle, registrar | deployments per minute; time from `CreateDeployment` to the first served request; build failures by cause |
| PS-2 steady through the edge | runtime-isolation S1 shape through CloudFront, across every cell | every hop | latency per hop; edge overhead; router compute utilisation |
| PS-3 herd through the edge | S2 shape: cold ingress instances in every cell, 0 to the peak rate in 5 s | cold starts in every cell at once, per-account quotas | refusals by tenant and cell; STS and Lambda throttles by account |
| PS-4 noisy neighbour | S3 shape: one tenant at 10x its limit | the per-tenant limit behind the edge (`single` mode limits at the origin) | that tenant refused; every other tenant on its cell served |
| PS-5 churn under load | during PS-2: create, suspend, resume and delete the churn count of tenants | control-plane writes reaching the edge and the cells | time to routable; time to suspended (503 at the edge); time to removed (403 at the edge); no request for a removed tenant at an origin |
| PS-6 long streams | S5 shape through CloudFront | streaming through the edge | first byte at the client against first byte at the ingress; broken streams |
| PS-7 cross-cell probes | during PS-2: a token whose payload names a tenant in another cell, a client route header, a direct call to a cell origin | the router, the route hint check, origin access control | every probe refused at the cell or the origin, never served |
| PS-8 peak | S6 shape at the tier's peak for 60 s | the shared quotas at their limit | the first quota that gives out, per account; every refusal attributed |

### 5.2 Slice scenarios

Each slice keeps scenarios of its own for `slice` mode:

| Slice | Scenarios |
|---|---|
| `agentic-runtime-isolation` | S1 to S7, as in its stress-test plan |
| `control-plane` | placement races (many `CreateDeployment` on one nearly full cell), read rate (`ListDeployments`, `ListCells` under writes), build-limit scaling (onboarding rate at 5, 20 and 50) |
| `tenant-identity` | token issue and refresh rate against the platform and `/oauth2/token` throttles; `CreateTenant` under Cognito throttling (runtime-isolation finding F-3) |
| `tenant-front-door` | route write rate and time to edge; router compute with large tokens; edge refusals with no origin call |

### 5.3 Isolation assertions

Every request through the edge checks four things (P-1):

| Layer | Check | Failure means |
|---|---|---|
| Edge | the response's route hint names the token's tenant | the router routed on something other than the token |
| Cell | the cell lists the tenant | a tenant reached a cell that does not host it |
| Ingress and agent | `tokenTenant` and the unit prefix are the tenant's | the wrong grant or unit reached the Runtime |
| Credential | `read <A>` succeeds, `read <B>` is `AccessDeniedException` | the vended credential is not scoped |

## 6. Observability

Latency is measured per hop with one correlation id per request: the driver
sends `x-correlation-id`, and each hop logs it (stress ADR-0005).

| Hop | Source |
|---|---|
| Client to edge | k6 timings |
| Router | CloudFront Functions `FunctionComputeUtilization`; the router's log line |
| Edge to cell origin | CloudFront real-time or standard logs (`time-taken`, origin latency) |
| Cell origin | the origin's log line |
| Ingress, Runtime, tools | runtime-isolation `request served` and `tool admitted` lines |
| Onboarding | control-plane deployment status times; CodeBuild build durations |

Edge overhead is client TTFB minus ingress TTFB, per request, joined on the
correlation id.

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
| 5 | The `large` fleet is a fixture, seeded once | onboarding 4,000 tenants takes hours even at 50 builds | stress ADR-0004 |
| 6 | A correlation header, logged at every hop | the runtime-isolation ingress and the front door each log it; a change to both samples | stress ADR-0005 |
| 7 | The cell script deploys runtime-isolation with the CDK from a pinned commit, through the account's role pair and a scoped cell bootstrap | the cell build would otherwise act as an account administrator; see below | stress ADR-0006, stress ADR-0011, stress ADR-0012, stress ADR-0014, control-plane ADR-0047 |
| 8 | The runtime-isolation `StressDriver` and k6 library move to `stress/` | they become the shared driver; its slice keeps only its own scenarios | stress ADR-0007 |

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
Q-5.

## 9. Work items and parallel readiness

| Work item | Needs | Ready to build in parallel |
|---|---|---|
| W-1 contract: `tiers.ts`, result schema, budget, runner | decision 1 | yes |
| W-2 driver and k6 library moved to `stress/` | W-1 schema | yes, once W-1's schema is fixed |
| W-3 runtime-isolation slice on the contract | W-1, W-2 | yes, after W-1 and W-2 |
| W-4 control-plane build-limit prop | decision 2 | yes, now |
| W-5 control-plane slice and the stress application | W-1, W-4, W-10; W-11 for Q-1 and the account check | done: the slice in `samples/control-plane/scripts/stress/`, the stress application and the role pair in `stress/application/` (stress ADR-0012 to ADR-0015); Q-1 answered |
| W-10 `cellBuildManagedPolicyArns` prop; cell execution policy, permissions boundary, workload boundary, `/cell/` path aspect and the cell bootstrap, in `stress/application/` | decision 7; the deny probes ran in the path spike (`stress/spikes/cell-path/`); the second boundary is ADR-0011 | done: the prop in control-plane ADR-0047, the rest in `stress/application/` |
| W-11 two standalone cell accounts, bootstrapped with the cell bootstrap and the role pair | §3.7; W-10's policies and prop for the bootstrap and the role pair | done in both cell accounts: the owner stacks, `CDKToolkit-cell` and the role pair (`stress/application/deploy-role-pair.sh`, W-5); the account check passes on both |
| W-6 tenant-identity slice and stress identity fixture | W-1, decision 3 | yes, after W-1 |
| W-7 front-door slice | the front door merged; its spikes S-2, S-3, S-5, S-7 passed; W-1 | no: blocked on the front door |
| W-8 correlation header in the ingress and the front door | decision 6 | ingress part yes; front-door part after its merge |
| W-9 first platform run at `small` | W-3, W-5, W-6, W-7, W-8, W-11 | no |

## 10. Open questions

| # | Question | Needed by |
|---|---|---|
| Q-1 | How long does one cell take to deploy from a CodeBuild cell script (expected about 8 minutes on Runtime V2), and does `BUILD_GENERAL1_SMALL` (3 GB) hold the synth? | Answered: a cell takes 486 s from `CreateDeployment` to the cell `ACTIVE`; inside the cell build the install takes 20 s, the synth 10 s and the deploy 421 s. `BUILD_GENERAL1_SMALL` holds the synth: the container has 3,831 MiB and 2 vCPUs and peaks at 1,977 MiB (`stress/application/README.md`, Results, run `20261120T142632Z`) |
| Q-2 | Does the front door's integration test compose runtime-isolation for `/agents/*` (its Q-4)? The platform run assumes it can | W-7 |
| Q-3 | Does the platform run keep the `large` fleet in every account between runs, and what does it cost idle? | decision 5 |
| Q-4 | Which hosted zone does the stress front door use? | W-7 |
| Q-5 | Does the request path work in a standalone cell account with every role on `/cell/` (authoriser, TVM `sts:AssumeRole` of a `/cell/` tenant role, the model call, tools)? Proven by the first platform run at `small` | W-9 |
| Q-6 | Does runtime-isolation's package entry export what the stress cell app needs (`RuntimeIsolationDemoStack`, `parseDemoContext`, `bundleAgent`)? The path spike imports them from `src/` by path | W-5 kept the path imports: `stress/application/cell-app.ts` loads them from the sample's `src/` with the sample's own CDK; an export is not needed for the stress test |
