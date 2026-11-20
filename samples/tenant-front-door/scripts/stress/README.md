<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Front door stress slice

The `tenant-front-door` slice of the platform stress test
([`docs/stress-test.spec.md`](../../../../docs/stress-test.spec.md) §3.4,
[`stress/README.md`](../../../../stress/README.md)). It runs the front door
alone, in slice mode, on the smoke stack (`test/smoke/smoke.app.ts`): the real
edge, router, route table and registrar; a stand-in control plane and one
demo cell. It measures how fast a route reaches the edge, what the router
costs with large tokens, which refusals never reach an origin, and whether the
router ever sends a request to a tenant it was not for.

Platform mode (`STRESS_MODE=platform`) runs the same front door in front of the
real control plane, its global hooks and the cell scripts' cell, in two phases,
and runs PS-7 against the ingress as well. It is described under
[Platform mode](#platform-mode); the rest of this file is slice mode.

## Run it

You need AWS credentials for a non-production account, with the rights to
create the stacks (an IAM role, a CloudFront distribution and web ACL, Lambda
functions, API Gateway, DynamoDB, Cognito); that account bootstrapped for the
CDK in the Region you choose and in `us-east-1`; a public hosted zone in it for
a test subdomain; and the `tenant-identity` shared-pool deployment's published
parameters (`/application-plane/shared/identity/*`) in some Region. On the
machine: bash, the AWS CLI, `jq`, node, the `smithy` CLI (the registrar's
generated server code is built on a fresh checkout) and `npm ci` in this
sample and in `stress/`.

```bash
export AWS_REGION=<region for the front door>
export STRESS_FD_IDENTITY_REGION=<region of tenant-identity; default AWS_REGION>
export STRESS_FD_ZONE_ID=<hosted zone id of the test subdomain>
export STRESS_FD_ZONE_NAME=<its name>
export STRESS_PREFIX=<1 to 28 letters and digits, starting with a letter>
export INTEG_DEPLOY_CONCURRENCY=2
cd stress
./run.sh run --tier small --slices tenant-front-door
```

The runner calls `slice.sh` with each verb (`budget`, `deploy`, `seed`,
`run <scenario>`, `collect`, `teardown`), writes `results.md` and the records
under `$STRESS_HOME/$STRESS_PREFIX/<run id>/`, and tears down when anything
fails. `STRESS_HOME` defaults to `~/.aaa-stress`. The tier is `small`; the
slice reads `STRESS_TIER_JSON` and seeds `min(tenantsActive, 100)` active
tenants, a write pool of `min(100, tenantsSeeded)` plus the sustained writes
(30 at `small`, up to 60), and one spare: 71 tenants at `small`, up to 261 at
`large`. A deploy takes about 11 minutes (the main stack, with the
distribution, is most of it) and a destroy of the stacks about 9, with about
6.5 more when `teardown` removes 71 tenants (see Measured).

| Input | Meaning |
|---|---|
| `STRESS_PREFIX` | names the stacks (`<prefix>-support`, `-control-plane`, `-edge`, `-main`, `-edge-logging`, `-cell`), the CDK construct id, the stand-in hook role (`<prefix in lower case>-global-hook`) and the application domain |
| `STRESS_FD_ZONE_ID`, `STRESS_FD_ZONE_NAME` | the test subdomain's hosted zone; the front door's `appDomain` is `<prefix in lower case>.<zone name>`: one name per run prefix, so two runs never share a host |
| `STRESS_FD_IDENTITY_REGION` | the Region of the `tenant-identity` shared pool when it is not `AWS_REGION` |
| `STRESS_CONTROL_PLANE_URL`, `CONTROL_PLANE_TOKEN` | slice mode, in a run that has a control plane: `teardown` then runs `scripts/register-hooks.sh --delete` before it destroys any stack. Platform mode ignores them: the control-plane step `unhook` unregisters the hooks |

The zone question of the stress spec (Q-4, which hosted zone the stress front
door uses) is settled here: the account's existing test subdomain zone, one
application domain per run prefix under it, passed in `STRESS_FD_ZONE_ID` and
`STRESS_FD_ZONE_NAME`. No domain is written into the repository.

## What it does (slice mode)
| Verb | Does |
|---|---|
| `budget` | prints the draw on Lambda concurrency (the registrar's burst plus a quarter second of the cell at the peak rate); no credentials |
| `deploy` | the smoke stacks, then the front door's three stacks one at a time, then the cell; prints `stack=<name> deploy_seconds=<n>` for each. Fails at once when another front door holds the edge parameter in this Region |
| `seed` | tenants in `tenant-identity`, each tenant's namespace parameter in the cell's Region and its records in the stand-in control plane, the cell route and the active tenants' routes written through the registrar as the global hook role, and a wait until every active route answers five times in a row |
| `run <scenario>` | one scenario, one result record, one request log (below) |
| `collect` | reads the edge and cell logs and the router's metrics for each scenario's window and checks them against the driver's counts; writes the `edge` hop and the router's compute utilization into the records |
| `teardown` | the run's tenants, routes and parameters; the front door's global hooks when there is a control plane; then the stacks, last deployed first; then a check that nothing is left. Prints `stack=<name> destroy_seconds=<n>` for each |

## Scenarios

| Id | What it sends | Pass criteria |
|---|---|---|
| `PS-7` | per round: a plain request, a token whose payload names another tenant, a client `x-tenant-route` header, a client `x-tenant-token` header, a token with a `tenants` list, a claim with no route, and a direct call to the cell's function URL | a probe that must be refused is never served; the headers the client supplies change nothing; the cell's log holds exactly the requests the driver saw reach it (the plain request, the two header probes, and the forged tokens, which the cell refuses with 403); the router refuses the `tenants` list and the unrouted claim, and IAM refuses the direct call, so none of those three reaches the cell |
| `route-write` | a burst of 20 `PutTenantRoute` calls at once, then one a second for 30 s, as the global hook role; each written tenant is watched for 90 s with one request a second, then asked ten more times | every answer names the right tenant; after 90 s every request sees its route; the registrar answers a write with 200 or 503 only. No limit on the write cycle or the time to routable until they are measured, and a 503 that survives the driver's five attempts is counted by cause, not failed |
| `router-load` | 10 requests a second for 40 s, then 40 a second for 20 s, over the active tenants; one in five carries a token padded to about 8,000 bytes that the cell refuses | no mismatch; every refusal is the cell's `403` for the padded token or its rate limit |
| `edge-refusals` | 60 each of: no token, an undecodable token, a tenant with no route, a suspended tenant, a cross-site call, an Authorization over 8,192 bytes, `/agents`; first it routes the spare tenant, suspends it and reports the time from the suspend call to five 503s in a row | every request is refused with its reason; the cell's log has no line for the window |

Every answer is classified (`test/stress/classify.ts`) as served, or refused
with a reason that names the hop (`edge-no-route`, `cell-forbidden`,
`origin-iam-denied`, ...). A refusal is attributed to the tenant the request
named, or `-` when it named none, which is also what the edge log shows
(spec P-7). An answer no hop owns is an unattributed refusal and fails the
run; so does a driver-side timeout or network error (status 0), which no hop
answered. A 503 from the registrar is counted by cause: `route-table-busy`
(five ETag conflicts) or `control-plane-unreadable`.

The tokens come from `tenant-identity`'s test aid `IssueToken`; they live
5 minutes, so a scenario issues its own and issues new ones every 200 s while
it runs. Forged tokens reuse a real token's
header and signature, so the router (which never checks signatures,
ADR-0005) routes them and the cell refuses them.

## Correlation

The router can log one value with `cf.logCustomData`, and it logs the
tenant (ADR-0010). The slice adds no correlation header. Every response
carries `x-amz-cf-id`, and CloudFront's standard log carries the same value
as `x-edge-request-id`, so `collect` joins each request to its edge log line
on it. In three live runs 6,682 of 6,682, 6,681 of 6,681 and 6,681 of 6,681
requests joined. The same join gives the edge's own time (`time-taken`) as
the `edge` hop and shows that every router refusal is a
`FunctionGeneratedResponse`. The origin is joined by its counts, not per
request: the cell's log counts by status must equal the number of requests
the driver saw reach it.

`collect` writes more than the late `refusals` and `cost` fields of the
contract: it adds the `edge` hop to `latency`, and the router's highest
compute utilization of the scenario's minutes to `quotas.platform` under
`cloudfront-function-compute-utilization-pct`, a key that is not a budgeted
quota. The runner accepts both because it re-hashes the slice's own records
after `collect`. Each scenario waits up to 5 minutes for its own edge logs and
up to 5 for the cell's. A router error metric with no datapoint counts as zero
errors when the router's invocations were counted for the same minutes, and is
reported as not checked when they were not.

## Platform mode

`STRESS_MODE=platform` (spec §3.5, §5.1; stress ADR-0016 and ADR-0017). The
platform account holds the control plane, the stress identity, this front door
and the k6 host; the cell is in a cell account. The front door, the control
plane, its registrar and the stress identity share one Region (the route hook
checks the registrar's Region and the cell API's Region against the hook's), and
only the edge stack is in `us-east-1`. The runner calls the verbs in this order
(`stress/src/platform.ts`):

| # | Verb | What this slice does |
|---|---|---|
| 1 | `deploy` (after `tenant-identity` and `control-plane` deploy) | Phase one, `deploy-platform.sh`: the support stack with only the edge operator role, then the edge, main and edge-logging stacks with `agentIngress` unset (the edge refuses `/agents/*`), then the same app again with `registrarUrl`, which adds the `RouteHookAccess` stack. Each stack prints `stack=<name> deploy_seconds=<n>` |
| 2 | `seed` | Prints that there is nothing to seed: the control plane's tenants and routes come from its global hooks |
| 3 | control-plane steps `hooks`, `register`, `warm-up` | Not this slice's: the hook policy goes on the control plane, the hooks are registered, and one tenant builds the cell |
| 4 | `step phase-two` | `phase-two.sh`: reads the cell's ingress parameter, redeploys the main stack alone with `agentIngress` set and `registrarUrl` kept, waits until the edge routes `/agents/*`, rewrites `tenant-front-door.json` |
| 5 | `run PS-7` | The router probes of slice mode plus two direct calls to the ingress (below) |
| 6 | `collect` | The edge-log join of slice mode, for PS-7; the cell's log is not compared |
| 7 | control-plane step `unhook`, then `teardown` | The front door only, in the order below |

`route-write`, `router-load` and `edge-refusals` write routes, load the router
and suspend a tenant through the registrar, which the platform run leaves to the
control plane's hooks and PS-5; they stay slice mode, and `slice.sh run` refuses
them in platform mode (exit 2).

### Inputs and manifests

`AWS_REGION`, `STRESS_PREFIX`, `STRESS_HOME`, `STRESS_FD_ZONE_ID`,
`STRESS_FD_ZONE_NAME` and `INTEG_DEPLOY_CONCURRENCY` as in slice mode. The
files are in `$STRESS_HOME/$STRESS_PREFIX/`, JSON, ids and names only, mode 0600;
a missing file or field stops the verb with a message that names the file and the
slice that writes it.

| File | Written by | This slice |
|---|---|---|
| `identity.json` | `tenant-identity` deploy | reads `apiUrl` (the platform API where `IssueToken` is called) and `appClientId` (the placeholder SPA issuer). The stress identity publishes no fixed SSM parameters in platform mode, so nothing is read from `/application-plane/shared/identity/*` |
| `control-plane-connection.json` | `control-plane` deploy | `deploy` reads `region`, `accountId`, `fleet`, `applicationId`, `apiUrl` and the registrar's reader client `vendorIdp`; the account and Region must be those of the credentials and of `AWS_REGION` |
| `control-plane.json` | `control-plane` seed and steps | reads `seeded[]`, `identity[]` and `warmUp` (`cellApiDomain`, `ingressReaderRoleArn`, `ingressParameter`) |
| `tenant-front-door.json` | **this slice**: `deploy` (phase 1), rewritten by `step phase-two` (phase 2) | `edgeUrl`, `registrarUrl`, `agentBackend` (`default`), `appDomain`, `distributionArn`, `hookPolicyArn` (the `RouteHookAccess` policy, for the control plane's `globalHookManagedPolicyArns`), `operatorRoleArn`, `phase`; phase 2 adds `agentIngressUrl` (the ingress base URL: https, no secret in it) |

`outputs.json` in the slice's own state directory keeps what `collect` and the
driver need (`edgeLogGroup`, `routerFunction`, `identityApiUrl`, ...), as in slice
mode.

### Phase two

`step phase-two` reads `control-plane.json` `warmUp`, assumes the cell account's
ingress reader role with the run's own credentials (the driver's credentials
provider keeps them in memory; nothing prints or writes them; session name
`tfd-stress-phase-two`), and reads the one parameter the role allows, the cell's
ingress parameter `/application-plane/shared/agent-runtime/StressCell-<cell id>/ingress`.
The `baseUrl` in its JSON value becomes the front door's `agentIngress` input,
`https://<host>/<stage>` with no trailing slash (`agentIngressOf` in
`test/stress/platform.ts`; the front door's own validation takes the domain and
the origin path from it). The main stack is redeployed alone (`--exclusively`)
with `registrarUrl` kept: a CloudFront distribution update. The step prints
`phase two: <n> s` and `stack=<main> deploy_seconds=<n> phase=two`; the runner
adds the step's time to the slice's deploy seconds.

A distribution update takes minutes to reach every edge, so the step then polls
`GET /agents/<backend>/invocations` with an unsigned token for a made-up tenant
until the router's own `403` (no route for that tenant) comes back five times in
a row, for up to 10 minutes. Before phase two the same request gets the router's
`404`. Running the step again with the same ingress changes nothing in the stack.

### PS-7 in platform mode

The tenants are the control plane's `seeded[]` that have an `identity[]` entry,
the first `min(tenantsActive, 100)` of them, at least two. Tokens come from
tenant-identity's `IssueToken`, signed with the run's own credentials, and are
never written down. The probes of slice mode (control, forged payload, client
route header, client token header, `tenants` list, unrouted ghost tenant, direct
call to the cell origin with a token) run against the real cell; the cell origin
is `https://<warmUp.cellApiDomain>/`. Two probes per round are new:

| Probe | Sends | Pass |
|---|---|---|
| `ingress-forged-payload` | `POST <agentIngressUrl>/<backend>/invocations` with a token whose payload names another tenant (the request shape of the runtime-isolation k6 probe: `{conversationId, prompt: "report"}`) | refused with 401 or 403, never 2xx. The call does not pass the edge, so it has no `x-amz-cf-id` and is not joined to the edge log |
| `ingress-own-token` | the same call with the tenant's own token | served (2xx; the ingress is public by design, front-door spec §1.2) and the first `data:` line names the tenant as `tokenTenant`; the ingress's own rate limit (429) is counted as an attributed refusal |

The record is `tenant-front-door.PS-7.json` in `$STRESS_RESULTS`, `mode:
platform`. `collect` joins the driver's request log with the edge log
(`x-amz-cf-id` = `x-edge-request-id`) as in slice mode and checks the router's
error metrics; it does not compare the cell's log (the cell's log group is in
the cell account, which this slice cannot read) and says so in its notes.

### Teardown

The runner runs the control-plane step `unhook` first (hooks unregistered, the
hook policy off the control plane's hook role). Then `teardown`, which refuses
to start when `RouteHookAccess`'s policy is still attached to a role (it names
the role and says to run `unhook` first; nothing is removed) and otherwise
deletes, in order: the `RouteHookAccess` stack; the hook parameter
`/application-plane/applications/<application id>/shared/front-door-hook`, which
the stack retains; edge logging; main; edge; the support stack. It checks that no
stack, resource, log group, edge parameter or hook parameter is left, and only
then removes `tenant-front-door.json` and the slice's state; otherwise the trail
stays and the run exits non-zero. `--fixtures` changes nothing: the front door
has no fixtures. Log groups that CDK's custom resource functions leave are listed
with the line that removes each, as in slice mode.

Use one prefix in one mode only: both modes name their support stack
`<prefix>-support`, and the platform run's support stack has no stand-in hook role
(the smoke app's `smokeHookRole=false`), which the slice-mode run needs.

## Measured (small tier)

Three runs on 2026-11-20 from a non-production test account: front door in
eu-west-2, `tenant-identity` in eu-central-1, edge in us-east-1, one driver
host. Runs 1 and 2 are of an earlier version of this code (without the token
refresh retry and the stricter join checks); run 3 is the gate run of the
final code, which `stress/run.sh run --tier small --slices tenant-front-door`
reported as PASSED. Latencies include the driver host's network path to
CloudFront.

| Measure | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Registrar write cycle p50 / p95 / p99 | 0.51 / 7.16 / 8.16 s | 0.50 / 7.49 / 8.33 s | 0.50 / 7.76 / 8.59 s |
| Burst of 20 writes at once, time to write them all | 16 s | 16 s | 15 s |
| Registrar 503 (`route-table-busy`) | 4 of 54 calls | 5 of 55 calls | 5 of 55 calls |
| Time to routable p50 / p95 / p99 | 23.1 / 47.1 / 58.1 s | 40.1 / 49.1 / 50.1 s | 29.2 / 37.1 / 38.1 s |
| Time to last miss p50 / p95 / p99 | 39.0 / 57.0 / 59.0 s | 41.0 / 52.0 / 54.0 s | 34.0 / 57.0 / 60.0 s |
| Routes served once and then refused again | not counted | 30 of 50 routes, 75 requests | 29 of 50 routes, 210 requests |
| Suspend call to five 503s in a row | 30 s | 30 s | 60 s |
| Client latency, served `whoami`, p50 / p99 | 0.05 / 0.11 s | 0.05 / 0.11 s | 0.05 / 0.12 s |
| Edge refusal latency, p50 / p99 | 4 / 9 ms | 3 / 7 ms | 3 / 8 ms |
| Router compute utilization, highest minute | 94 % | 94 % | 94 % |
| Isolation | 0 mismatches in 4,913 assertions | 0 in 4,680 | 0 in 5,120 |
| Unattributed refusals | 0 | 0 | 0 |

Deploy and destroy time, seconds, from the clean deploy of run 2 and the
teardown of run 3 (the runner's own figures for run 3, 178 s to deploy and 913 s
to destroy, include a deploy that reused stacks that were already up and a sweep
of 71 tenants that took about 6.5 minutes):

| Stack | Deploy | Destroy |
|---|---|---|
| `<prefix>-support` | 54 | 23 |
| `<prefix>-control-plane` (stand-in) | 70 | 43 |
| `<prefix>-edge` (us-east-1) | 65 | 36 |
| `<prefix>-main` (distribution, router, registrar) | 341 | 325 |
| `<prefix>-edge-logging` (us-east-1) | 62 | 60 |
| `<prefix>-cell` | 71 | 34 |
| Total | 663 | 521 |

What the numbers say:

- A write takes half a second when alone and up to about 9 s when 20 contend
  for the store's one ETag; about one call in twelve ends in 503 after five
  attempts. The route hook retries those. The 15 to 16 s the burst took
  includes the driver's own wait (about 5 s) before it retries a 503, so it is
  an upper bound on the store's time, not its throughput.
- A route is not seen everywhere at once. Edge locations learn a write at
  different times, up to 60 s in these runs, and a request can see a route and
  then lose it before it settles. That is longer than the 45 s the route hook
  waits for propagation. A suspension took 30 to 60 s after the call to show
  as five 503s in a row. After 90 s every request saw every route.
- The router's compute utilization reaches 94 % in a minute with ordinary
  load. In run 3 the highest minute was 94 % for `PS-7`, `route-write` and
  `router-load` and 40 % for `edge-refusals`. The metric has one point a
  minute, so a short scenario shares its minute with its neighbours and each
  figure is an upper bound; it cannot show whether the padded tokens of
  `router-load` cost more than ordinary ones.

## Known limitations

- **One front door per Region, fixed SSM name.** The front door publishes
  `/application-plane/shared/front-door/edge`, a name with no prefix. A second
  front door in a Region and account fails at the parameter, and `deploy`
  refuses to start when it finds the parameter. These runs used eu-west-2,
  because eu-central-1 and eu-west-1 each held another front door, and kept
  `tenant-identity` in eu-central-1 (`STRESS_FD_IDENTITY_REGION`). The
  platform run needs a Region of its own for its front door.
- CloudFront policy names and other account-wide names derive from the CDK
  construct id, so `src/main.ts` takes the id from `stackNamePrefix`; two
  front doors in one account need different prefixes as well as different
  Regions.
- Slice mode: the registrar reads a stand-in control plane, and the global hook
  role is a role of the same account. Nothing in slice mode runs the route hook
  script, the real hooks or the cell scripts, and `teardown` has never run
  `register-hooks.sh --delete` live (a slice-mode run registers no hook).
- Platform mode has not run live. `deploy-platform.sh`, `phase-two.sh` and the
  platform branches of `teardown.sh` and `slice.sh` are checked with `bash -n`
  only (no `shellcheck` here); the pure parts (manifests, outputs, the
  `agentIngress` derivation, the probe classification) have unit tests. Not
  exercised without AWS: the CDK deploys, the `RouteHookAccess` hook stack's
  deletion order, the phase-two wait, the ingress probes against a real ingress
  (the shape is the k6 probe's; an ingress whose first `data:` line is not the
  `report` fails PS-7 as a mismatch), and `collect` without a cell log.
- Platform PS-7 sends one `report` per round to the ingress, which opens a
  Runtime session for the tenant's conversation: 10 at `small`, 25 above it.
  A cold session can take longer than the edge probes; those calls wait up to
  90 s.
- Phase two is a distribution update on every run; its time is the number to
  watch (stress ADR-0016 consequences). A run that fails between the
  `context.json` write and the manifest rewrite leaves `agentIngress` in the
  context and the manifest at phase 1: run the step again, it is idempotent.
- `deploy` in platform mode rewrites `context.json` without `agentIngress`: do
  not run it again after phase two on the same prefix.
- No quota ids for CloudFront Functions compute or the API Gateway control
  plane: neither has a Service Quotas code (checked with `list-service-quotas`
  for `cloudfront` and `apigateway`), so `stress/src/budget.ts` has nothing
  to name and the slice declares only Lambda concurrency. The router's compute
  utilization is reported in the record under a key of its own.
- At most 100 active tenants and a write burst of `min(100, tenantsSeeded)`;
  only the small tier (a burst of 20) has run. At `medium` and `large` a
  scenario that outlasts 5 minutes relies on the token refresh, which has not
  been run that long, and `large`'s tenants stay between runs while its stacks
  and their stand-in control plane records do not: `seed` writes the records
  again for every tenant of the manifest.
- The driver runs on the host that runs the slice, not the stress driver host,
  so client latencies include that host's path to CloudFront.
- A failed first write is retried four more times, 5 s apart; the real hook
  retries five times over about two minutes.
- CloudFront's own metrics have one point a minute; short scenarios share
  minutes.
- Teardown leaves the log groups that CDK's custom resource functions create
  (Lambda makes them on the first call and no stack owns them) and any log
  group a still-logging function makes again after the stack deleted it. They
  are listed with the `aws logs delete-log-group` line that removes each, and
  they do not fail the check. Any other leftover does.
- The cell's per-tenant limit (2,000 requests per 5 minutes) is shared by every
  scenario of a run; a larger tier may see `cell-rate-limited` answers, which are
  counted as attributed refusals and are allowed for legitimate requests.

## Files

| File | Holds |
|---|---|
| `slice.sh`, `slice.json` | the verbs and the declaration the runner reads |
| `deploy.sh`, `teardown.sh`, `lib.sh` | stacks and what they leave behind (slice mode; `teardown.sh` also does platform mode) |
| `deploy-platform.sh`, `phase-two.sh` | platform mode: front-door phase one, and phase two |
| `../../test/stress/` | the driver: `driver.ts` (verbs), `scenarios.ts`, `classify.ts`, `sink.ts`, `recorder.ts`, `collect.ts`, `join.ts`, `clients.ts`, `sigv4.ts`, `plan.ts`, `platform.ts` (the other slices' manifests, platform PS-7, the `agentIngress` derivation); unit tests in `stress.test.ts` and `platform.test.ts` |
