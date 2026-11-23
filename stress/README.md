<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: the shared contract

The code every sample's stress slice plugs into, so the samples can be
stress-tested alone or together as one agent platform. The design is
[`docs/stress-test.spec.md`](../docs/stress-test.spec.md); the decisions are
in [`adr/`](./adr/README.md). It is a test asset that deploys the driver
host, for the length of a run, and the stacks in `application/` that stay in
each standalone cell account: the account owner's stacks and the
control-plane role pair. `application/` also holds the stress application,
whose cell and tenant scripts the control-plane slice runs.

| Part | File | What it holds |
|---|---|---|
| Tiers | [`src/tiers.ts`](./src/tiers.ts) | `small`, `medium`, `large`: accounts, cells, agents, tools, tenants, rates (spec §4.1) and the rules a tier keeps |
| Slice declaration | [`src/slice.ts`](./src/slice.ts) | what `scripts/stress/slice.json` in a sample holds, and the order slices run in (spec §3.4) |
| Quota budget | [`src/budget.ts`](./src/budget.ts) | the account-wide quotas slices draw on, with their Service Quotas codes and defaults (spec §4.4) |
| Result records | [`src/result.ts`](./src/result.ts) | one JSON record per slice per scenario, its checks and the results file (spec §4.3) |
| Runner | [`src/runner.ts`](./src/runner.ts), [`run.sh`](./run.sh) | budget, then `deploy`, `seed`, `run`, `collect` in dependency order, `teardown` in reverse (spec §3.5) |
| Driver host | [`driver/`](./driver/stress-driver.cdk.ts) | the k6 host every slice runs its load from: one EC2 instance, no inbound rule, no public IP, SSM Session Manager (ADR-0007, ADR-0009) |
| k6 library | [`k6/`](./k6/README.md) | tokens, pacing, the correlation header and the result record every slice's scenarios share (ADR-0008) |
| Cell account owner's stacks and the stress application | [`application/`](./application/README.md) | the cell policies, the account base, the `/cell/` path aspect, the cell bootstrap and its probes, the control-plane role pair, and the stress application's cell app and cell and tenant scripts (spec §3.1, §3.7, §8 decision 7; ADR-0006, ADR-0011, ADR-0012, ADR-0014) |

## A slice

A sample joins with two files in `samples/<name>/scripts/stress/`:

```json
{
  "name": "control-plane",
  "needs": ["tenant-identity"],
  "scenarios": ["PS-1", "PS-5", "placement-race"],
  "platformOnly": ["PS-5"],
  "quotas": ["codebuild-linux-small", "lambda-concurrency"]
}
```

`needs` names the slices this one reads through their published interfaces, or must follow
in the order of a platform run (spec §3.4: `tenant-identity`, `control-plane`,
`tenant-front-door`, then `agentic-runtime-isolation`). `control-plane` reads nothing from
`tenant-identity`; its need only orders the run. The runner puts every slice after the
slices it needs, and refuses a need that is no slice, a need left out of `--slices` and a
cycle. With one slice named (slice mode) its needs are not required. A scenario in
`platformOnly` needs the other slices' interfaces (the edge, the cells the control plane
built): a slice-mode run leaves it out, and refuses one named in `--scenarios`.

and `slice.sh <verb> [args]`, where the verb is one of:

| Verb | Does | Prints or writes |
|---|---|---|
| `budget` | its draw on each declared quota at `$STRESS_TIER`, without credentials (no `AWS_*` variables, an empty `HOME`, no instance metadata) | stdout: `{"draws": [{"account": "platform" \| "cell-account-<n>", "quota": "<id>", "amount": <n>}]}` |
| `deploy` | deploys or reuses its stacks; publishes what the next slice needs through its published parameters, or a manifest in `$STRESS_HOME/$STRESS_PREFIX/` | - |
| `seed` | creates or reuses its data; never writes a token or a password | manifests in `$STRESS_HOME/$STRESS_PREFIX/` |
| `run <scenario>` | runs one scenario; exits non-zero when a pass criterion fails | `$STRESS_RESULTS/<name>.<scenario>.json` |
| `collect` | reads logs and metrics for the run window | may fill in its own records' late fields (`refusals`, `cost`) in `$STRESS_RESULTS` |
| `teardown [--fixtures]` | removes what it deployed; keeps fixtures unless `--fixtures` | - |

Every verb gets `STRESS_TIER`, `STRESS_TIER_JSON` (the whole tier, as
`run.sh tier <name>` prints it), `STRESS_RUN_ID`, `STRESS_PREFIX`,
`STRESS_HOME`, `STRESS_MODE` (`slice` or `platform`), `STRESS_RESULTS`,
`STRESS_REPO` and `STRESS_COMMIT`. `cell-account-<n>` counts from 1 and
stops at the tier's `cellAccounts`; a draw on any other account fails the
run. The runner times `deploy` and `teardown` itself and writes one
`lifecycle` record per slice with the deploy and destroy seconds.

Slices run in the order of their `needs`, and each one deploys and then seeds before the next
starts, so a slice's `deploy` can read what an earlier slice seeded (the front door needs
the control plane's application). `teardown` runs in reverse order. Without `--scenarios`, a
slice-mode run runs the slice's scenarios except its `platformOnly` ones (any `PS-<n>` first, by
number), and a platform run (several slices) runs only the `PS-<n>` scenarios, by number;
`--scenarios` runs the scenarios named, in the order given, and can name any scenario a
slice declares (a slice-mode run refuses a `platformOnly` one). A run left with no scenario
to run, a platform run with no `PS-<n>` scenario or a slice run whose scenarios are all
`platformOnly`, is refused too. A scenario no slice declares is refused before the run
starts, so the run id stays free.

A run fails when a scenario's record is missing, does not parse, belongs
to another run, or makes no isolation assertion, when a record names a
slice or a scenario the run did not run, when a record is already there
before its own `run` starts (the runner removes it), and when a record
changed after its own `run` returned (another slice rewrote it). Only the
slice's own `collect` may change its records after `run`, and only
records nobody else changed.

Each verb runs in its own session and process group with no stdin, so
`slice.sh` must not prompt (`cdk deploy --require-approval never`). Its
stdout and stderr go through the runner to the terminal and to
`$STRESS_HOME/$STRESS_PREFIX/<run id>/run.log` (folder 0700, file 0600), so
a verb never prints a token, a password or a key, and never runs `set -x`
around one. When `slice.sh` exits,
anything it left running in its group gets SIGTERM, then SIGKILL after
30 seconds.

## Platform mode: set-up order

A run with several slices sets `STRESS_MODE=platform`. The slices' set-up interleaves
(spec §3.5, stress ADR-0018): the runner calls each slice's `deploy`, `seed` and `step <name>`
in the order of `src/platform.ts`, and a slice lists the steps it implements under `steps` in
its `slice.json`. In the order of a full run:

| # | Slice | Action |
|---|---|---|
| 1 | `tenant-identity` | `deploy`, `seed` |
| 2 | `control-plane` | `deploy` (no application yet), `seed` |
| 3 | `tenant-front-door` | `deploy` (phase one), `seed` |
| 4 | `control-plane` | `step hooks`, `step register`, `step warm-up` |
| 5 | `tenant-front-door` | `step phase-two` |
| 6 | `agentic-runtime-isolation` | `deploy`, `seed` |

Teardown runs in the reverse order of the slices, with the control plane's `step unhook` before the
front door's `teardown`. A platform run needs `STRESS_HOOK_COMMIT` (spec §3.6, `hookCommit`) and,
in the cell accounts file, `ingressReaderRoleArn` for each cell account.

## Platform mode: manifests

A slice works on what the others made and reads it from manifest files in
`$STRESS_HOME/$STRESS_PREFIX/`: ids and names only,
never a token, a password or a key, mode 0600 in a 0700 folder. A slice that finds a manifest
missing or unusable stops with a message that names the file, the slice that writes it and,
when the content is wrong, the field.

Who owns which platform scenario (spec §5.1):

| Scenario | Slice | What runs in platform mode |
|---|---|---|
| PS-1 | `tenant-identity`, `control-plane` | the onboarding each slice already runs in slice mode; the control-plane slice also creates each tenant's identity tenant and users and polls the edge until `/api/whoami` is served (stress ADR-0017, ADR-0020) |
| PS-2, PS-3, PS-4, PS-6, PS-8 | `agentic-runtime-isolation` | its S1, S2, S3, S5 and S6 load shapes sent to `<edgeUrl>/agents/<agent>/invocations`; the record carries the `PS-n` id |
| PS-5 | `control-plane` | the tier's churn count of the churn tenants (`churn` in `control-plane.json`): each one's deployment created, its route suspended and resumed, and the deployment deleted, each change timed from its call to the first edge answer that shows it |
| PS-7 | `tenant-front-door` | probes at the router and at the ingress, with the tenants of `control-plane.json` |

The manifests a platform run reads and writes:

| File | Written by | Read by | Holds |
|---|---|---|---|
| `identity.json` | `tenant-identity` `deploy` | `control-plane`, `tenant-front-door`, `agentic-runtime-isolation` | the value of the SSM parameter `/<prefix>/identity`: `region`, `apiUrl` (execute-api URL of the platform API), `userPoolId`, `appClientId` (the issuer is `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`) |
| `tenant-identity.json` | `tenant-identity` `seed` | the identity slice's own scenarios | `seeded[]`: `tenantId`, `name`, `admin` and `users[]`, each `{username, email}`; the platform's tenants are not in it |
| `control-plane-connection.json` | `control-plane` `deploy` | `tenant-front-door` | `region`, `accountId`, `fleet`, `applicationId`, `apiUrl`, `vendorIdp` (`tokenUrl`, `clientId`, `clientSecretArn` of the registrar's reader client) |
| `control-plane.json` | `control-plane` `seed`; its driver adds `identity[]` and `warmUp` | `agentic-runtime-isolation`, `tenant-front-door` | `seeded[]`, `churn[]`, `extra[]`: tenant ids. `seeded` is the platform's steady set; `churn` and `extra` belong to the control-plane scenarios. `identity[]`: each identity tenant the driver created, `tenantId`, `admin` and `users[]`. `warmUp`: the warm-up tenant, its cell and account, `cellApiDomain`, `ingressReaderRoleArn`, `ingressParameter` |
| `tenant-front-door.json` | `tenant-front-door` `deploy`, rewritten by `step phase-two` | `agentic-runtime-isolation`, `control-plane` | `edgeUrl` (an https origin, no path); `registrarUrl` (the registrar's execute-api URL with its stage); `agentBackend` (optional, default `default`); `appDomain`, `distributionArn`, `hookPolicyArn`, `operatorRoleArn`, `phase`; after phase two `agentIngressUrl` |

The front-door slice writes `tenant-front-door.json`, and the fields above are the contract it
meets. The edge serves agents at `/agents/<backend>/invocations` and reads the tenant from the
token (front-door spec §3.3). `edgeUrl` is an edge in the front door's `single` addressing
mode, where the token alone names the tenant, and its host is the front door's `appDomain`; in
`host` mode, or on any other host, the router looks the host up first and answers 404 or 403
whatever the tenant's state.

What a slice does in platform mode:

| Slice | `deploy` | `seed` | `run` | `collect` | `teardown` |
|---|---|---|---|---|---|
| `tenant-identity` | as in slice mode, then writes `identity.json` | as in slice mode, a probe set of tenants | PS-1 as in slice mode | as in slice mode | as in slice mode; `--fixtures` also removes `identity.json` |
| `control-plane` | checks the cell accounts, deploys the control plane with the registrar's reader client, writes the connection manifest | as in slice mode | PS-1 with identity and the edge poll; PS-5 reads `tenant-front-door.json` | as in slice mode | as in slice mode, and deletes the identity tenants of the deployments it removes |
| `tenant-front-door` | phase one: operator role, edge, main, logging, `RouteHookAccess` | nothing | PS-7 | joins the driver's request log with the edge log | `RouteHookAccess`, its parameter and the stacks, after the control plane's `unhook` |
| `agentic-runtime-isolation` | checks the manifests; deploys the k6 host `<prefix>-driver` only when none is there | checks the manifests, seeds nothing | picks the tenants (below), runs the load through the edge | takes each refusal's tenant and reason from the driver's own lines | removes its run files, and the k6 host only when its `deploy` made it |

`agentic-runtime-isolation` drives, in platform mode, every tenant in `control-plane.json`
`seeded` that has an entry with an admin user in the same file's `identity[]`, and nothing else.
It builds this set when each scenario starts, because the control plane onboards its tenants in
PS-1, after every `seed`. A control-plane tenant with no entry in `identity[]` is refused with
the reason `no-identity-tenant`, one with no admin user name with `no-user`; both are listed by
tenant id in the scenario's output and in `platform-tenants.json` in the slice's folder of
`$STRESS_HOME`, together with the identity tenants that are not in the steady set (`not-in-control-plane`,
ignored). The scenario stops when fewer than two tenants are usable (the read-other probe needs
two).

Every request through the edge that is refused (4xx, 5xx) or whose body shows a refusal gets a
tenant and a reason in the record's `refusals.byTenantReason`: the tenant is the driver's, the
reason is `http-<status>`, or `tool-<status>` for a tool refused inside a 200 (P-7). What a run
cannot attribute stays in `unattributed` and fails the run.

## The driver host and the k6 library

A slice runs its load from one host, `<prefix>-driver`, with k6 and the AWS CLI installed. It
is its own CDK app, run from `stress/`:

```bash
export AWS_REGION=eu-central-1 STRESS_PREFIX=StressDriver STRESS_TIER=small
driver/deploy.sh
driver/host.sh 'k6 version'
driver/teardown.sh
```

`deploy.sh` prints the deploy seconds, waits until the SSM Agent is online and the user data has
installed k6, prints those seconds as `ready_seconds`, then the stack outputs (`InstanceId`, `ResultsBucketName`);
`teardown.sh` prints the destroy seconds and checks nothing is left. The host reads the stress
identity, `/<STRESS_PREFIX>/identity` (ADR-0002), and `STRESS_PARAMETER_PREFIXES` lists further
SSM paths it may read (a slice's registry prefix). Its role holds no AWS managed policy (ADR-0009). `host.sh` runs one command on
the host through Run Command and reads its output from the results bucket.

`driver/k6.sh <script> [NAME=value ...]` runs a k6 script on the host: it mirrors `stress/k6/` and
the script's folder under `/opt/stress/repo/` at their repository paths, passes the `STRESS_*`
variables, and brings the result records back to `$STRESS_RESULTS`. A slice's `run` verb calls it
(the runtime-isolation slice's `run` verb does). The library, the record it writes and the
correlation header are described in [`k6/README.md`](./k6/README.md); `k6/smoke.js` is the
check that a deployed host runs k6 and writes a record `parseRecord` accepts.

## Run it

```bash
cd stress
./run.sh check
./run.sh tier small
./run.sh plan --tier small --slices tenant-identity,control-plane
AWS_REGION=eu-central-1 ./run.sh run --tier small --slices agentic-runtime-isolation --limits limits.json
./run.sh report ~/.aaa-stress/stress/<run id>/results
./run.sh quotas
```

`--limits` takes `{"platform": {"<quota>": <n>}, "cell-account-1": {...}}` with the
accounts' real values; a quota without a value uses its default, which is
the service default and often lower than an account holds. `run.sh quotas`
lists the Service Quotas codes to read them from
(`aws service-quotas get-service-quota --service-code <s> --quota-code <c>`).

The run id defaults to the start time (UTC); the runner refuses a run
folder that already exists. Ctrl-C, SIGTERM or a hangup (SIGHUP) stops the
current step, with everything it started, and then tears down every slice
that started. Signals during teardown are logged and ignored. An
interrupted run exits 129 (SIGHUP), 130 (SIGINT) or 143 (SIGTERM); a failed
run exits 1. Long runs belong in `tmux` or `screen`, or
`setsid ./run.sh run ... > run.out 2>&1 &`, so a dropped connection does not
interrupt them. `nohup` does not help: Node resets the ignored SIGHUP.

The run writes `$STRESS_HOME/$STRESS_PREFIX/<run id>/results.md`, with the
run's verdict (`PASSED` or `FAILED`) and every failure the runner found.
`run.sh report` renders every record in a results folder without checking
it against a run, so it shows no verdict and includes records the runner
refused; use `results.md` as the run's record. To keep a
run, copy that file to `stress/results/<date>-<tier>.md` and commit it
(spec §4.3); the raw records and logs stay outside the repository.

## Known limitations

- The lock is per prefix on the local host: the runner holds
  `$STRESS_HOME/$STRESS_PREFIX/run.lock` and refuses a second run with the
  same prefix there. A run from another host, or with another prefix,
  against the same accounts is not detected. Run one stress test per set of
  accounts at a time.
- One run per driver host. `stress/driver/k6.sh` clears `/opt/stress/repo`, `inputs` and `out`
  on the host before it unpacks, so two runs against one `<prefix>-driver` overwrite each other's
  files. Nothing on the host locks; give a concurrent run its own prefix and driver.
- Budget limits are what `--limits` says; without it the runner checks
  against service defaults, not the accounts' applied quotas.
- Scenarios run one after another, by default in the order of their
  numbers (spec §3.5), so PS-5 (churn) runs on its own after PS-4 and
  PS-7 (cross-cell probes) on its own after PS-6, without PS-2's load
  (spec §1.2, §5.1, stress ADR-0021).
- The quota catalogue has no ids yet for the API Gateway control plane,
  for CloudFront Functions compute and KeyValueStore size, or for the
  Cognito user-write categories that the control-plane driver's identity
  calls draw on (spec §4.4), so no slice can declare them. The
  front-door slice found no Service Quotas code for the API Gateway
  control plane or CloudFront Functions compute (its
  `scripts/stress/README.md`, Known limitations).
- Platform mode ran live once, at `small`, one cell account (`stress/results/2026-11-21-small.md`).
  `medium` and `large` are unproven: more cells need the per-cell ingress route (spec Q-7), and
  the ingress reader role is one per Region and account. A second Region in a cell account
  needs its own `CELL_POLICY_SUFFIX` and fleet name, because the policies and the role pair
  name Region-specific ARNs and IAM names are account-wide.
- PS-1 in platform mode times a tenant to its first served `/api/whoami`, not to an agent
  call, so it does not cross the ingress (stress ADR-0020). The cell's log is not compared in
  PS-7 (it is in another account). The PS-1 demo row is written with the cell owner's profile.
- A platform run of the identity and control-plane slices without the front door is accepted
  by the planner and fails in the warm-up step, after the cell build.
- PS-3 in platform mode cannot retire the cells' Lambda instances: they are in the cell
  accounts, where the slice has no write access. It waits 60 s idle and starts the herd from
  there, so its cold-start share is whatever the instances' age allows.
- PS-4 in platform mode does not evaluate S3's noisy-tenant row (no other tenant refused with
  a 429) or its delivery row; only the k6 delivery threshold holds. The slice's `budget` is the
  slice-mode figure, all on `cell-account-1`, so it overstates what one cell account draws.
- PS-2, PS-3, PS-4, PS-6 and PS-8 in platform mode attribute refusals from the driver's own
  lines. The edge's and the cells' logs are not joined, so the records hold the client's
  latency hops only and no quota peaks or cost. The driver prints one line for each refused
  request, so a scenario that refuses most of its requests (PS-4's noisy tenant) prints as
  many lines as refusals.
- `agentic-runtime-isolation` needs `tenant-front-door`, and no slice of that name exists, so
  the runner refuses every platform run that names `agentic-runtime-isolation` with
  `agentic-runtime-isolation needs tenant-front-door, which is not a slice`, or, when the run
  names `tenant-front-door`, with `no slice for tenant-front-door`. PS-2, PS-3, PS-4, PS-6
  and PS-8 are tested against stubs only until the front door declares its slice.
- A platform run that names a slice scenario (`S1` to `S7`) in `--scenarios` stops at that
  scenario's `run`, after every `deploy` and `seed`.
- A platform run of `tenant-identity` and `control-plane` runs `PS-1` and `PS-5` by default.
  PS-5 reads `tenant-front-door.json`, which nothing writes without the front-door slice, and
  stops with a message that names the file. Name `--scenarios PS-1` for such a run.
- PS-5 reads the edge with a token that names the tenant and carries no signature the router
  could check: the router does not verify it (front-door spec §3.3, step 5), so a probe reaches
  the ingress at most and is refused there. It shows what the router does for the tenant, not
  what a signed request would get.
- PS-5 tells the router's answers from the ingress's by the body. The router writes
  `{"status":403}` for a tenant with no route and `{"status":503}` for a suspended one. The
  `api-gateway` ingress answers 403 with the body `forbidden` for the unsigned token, which
  reads as a routed tenant when API Gateway's request id (`x-amzn-requestid`) is on it. An
  ingress whose refusal has a body of the router's shape, or a proxy that rewrites bodies,
  would read as no route. An answer with neither the router's body nor the request id (a 503
  CloudFront gives when the router function fails, a 403 for a geographic restriction) tells
  nothing and is read again; `x-cache` cannot tell these apart, because CloudFront sets
  `Error from cloudfront` on an origin's 4xx too. A run reports the tenant never routable
  when an ingress answers without the request id. The probe token names the tenant in the
  claim `tenant_id`, the front door's default `tenantClaim`: a front door with another claim
  answers 401, and PS-5 stops with that cause.
- PS-5 suspends and resumes tenants through the front door's route registrar with a SigV4
  call that `curl` (7.75 or later) signs with the driver session's own credentials. The
  registrar allows only its edge operator role for `UpdateTenantRouteStatus`, so the session
  that runs PS-5 must hold that role; with another role the finding reads `HTTP 403`, and with
  no credentials `HTTP 0`.
- The k6 library has no k6 run in this folder's build: `record.js` is tested, `lib.js` is
  checked by running `k6/smoke.js` and `K6_COMMAND=inspect` on a deployed host. A change to
  `lib.js` needs that check again.
- `refusals` in a record from k6 are all unattributed until the slice's `collect` joins them
  with the hops' logs (ADR-0008).
- A SIGKILL to the runner leaves the current verb's process group
  running, and the run lock in place.
- A process a verb starts with `setsid` leaves the group, so the runner
  cannot stop it, and while it holds the verb's stdout or stderr the verb
  does not end. Redirect the output of anything started that way.
- `run.log` keeps stdout and stderr as two pipes, so their lines can
  interleave out of the script's order.
- Off Linux, the runner cannot tell a zombie from a running process, so
  where pid 1 does not reap orphans, a verb that left a child behind
  waits the full 30 seconds plus 5 before it counts as done.

## Build

```bash
cd stress
npm ci
npx projen build
```
