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

Platform mode, with the real control plane, its global hooks and the cell
scripts, is not part of this slice. Every verb but `budget` exits 2 with a
message when `STRESS_MODE` is `platform`.

## Run it

You need a non-production account that is bootstrapped for the CDK in the
Region you choose and in `us-east-1`, a public hosted zone there for a test
subdomain, and the `tenant-identity` shared-pool deployment's published
parameters (`/application-plane/shared/identity/*`) in some Region.

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
fails. `STRESS_HOME` defaults to `~/.aaa-stress`. Tools: bash, aws, jq, node and
`npm ci` in this sample (run once when missing). The tier is `small`; the slice
reads `STRESS_TIER_JSON` and seeds at most 100 tenants at any tier.

| Input | Meaning |
|---|---|
| `STRESS_PREFIX` | names the stacks (`<prefix>-support`, `-control-plane`, `-edge`, `-main`, `-edge-logging`, `-cell`), the CDK construct id, the stand-in hook role (`<prefix in lower case>-global-hook`) and the application domain |
| `STRESS_FD_ZONE_ID`, `STRESS_FD_ZONE_NAME` | the test subdomain's hosted zone; the front door's `appDomain` is `<prefix in lower case>.<zone name>`: one name per run prefix, so two runs never share a host |
| `STRESS_FD_IDENTITY_REGION` | the Region of the `tenant-identity` shared pool when it is not `AWS_REGION` |
| `STRESS_CONTROL_PLANE_URL`, `CONTROL_PLANE_TOKEN` | only in a run that has a control plane: `teardown` then runs `scripts/register-hooks.sh --delete` before it destroys any stack |

The zone question of the stress spec (Q-4, which hosted zone the stress front
door uses) is settled here: the account's existing test subdomain zone, one
application domain per run prefix under it, passed in `STRESS_FD_ZONE_ID` and
`STRESS_FD_ZONE_NAME`. No domain is written into the repository.

## What it does

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
| `PS-7` | per round: a plain request, a token whose payload names another tenant, a client `x-tenant-route` header, a client `x-tenant-token` header, a token with a `tenants` list, a claim with no route, and a direct call to the cell's function URL | a probe that must be refused is never served; the headers the client supplies change nothing; the cell's log shows no request for any refused probe |
| `route-write` | a burst of 20 `PutTenantRoute` calls at once, then one a second for 30 s, as the global hook role; each written tenant is watched for 90 s with one request a second, then asked ten more times | every answer names the right tenant; after 90 s every request sees its route. No limit on the write cycle or the time to routable until they are measured |
| `router-load` | 10 requests a second for 40 s, then 40 a second for 20 s, over the active tenants; one in five carries a token padded to about 8,000 bytes that the cell refuses | no mismatch; every refusal is the cell's `403` for the padded token or its rate limit |
| `edge-refusals` | 60 each of: no token, an undecodable token, a tenant with no route, a suspended tenant, a cross-site call, an Authorization over 8,192 bytes, `/agents` | every request is refused with its reason; the cell's log has no line for the window |

Every answer is classified (`test/stress/classify.ts`) as served, or refused
with a reason that names the hop (`edge-no-route`, `cell-forbidden`,
`origin-iam-denied`, ...). A refusal is attributed to the tenant the request
named, or `-` when it named none, which is also what the edge log shows
(spec P-7). An answer no hop owns is an unattributed refusal and fails the
run. A 503 from the registrar is counted by cause: `route-table-busy` (five
ETag conflicts) or `control-plane-unreadable`.

The tokens come from `tenant-identity`'s test aid `IssueToken`; they live
5 minutes, and a scenario issues its own. Forged tokens reuse a real token's
header and signature, so the router (which never checks signatures,
ADR-0005) routes them and the cell refuses them.

## Correlation

The router can log one value with `cf.logCustomData`, and it logs the
tenant (ADR-0010). The slice adds no correlation header. Every response
carries `x-amz-cf-id`, and CloudFront's standard log carries the same value
as `x-edge-request-id`, so `collect` joins each request to its edge log line
on it. In the live runs 6,682 of 6,682 and 6,681 of 6,681 requests joined.
The same join gives the edge's own time (`time-taken`) as the `edge` hop and
shows that every router refusal is a `FunctionGeneratedResponse`. The origin
is joined by its counts, not per request: the cell's log counts by status
must equal the number of requests the driver saw reach it.

## Measured (small tier)

Two runs, 2026-11-20, a non-production test account, front door in eu-west-2,
`tenant-identity` in eu-central-1, edge in us-east-1, driver on one host.
Latencies include the driver host's network path to CloudFront.

| Measure | Run 1 | Run 2 |
|---|---|---|
| Registrar write cycle p50 / p95 / p99 | 0.51 / 7.16 / 8.16 s | 0.50 / 7.49 / 8.33 s |
| Burst of 20 writes at once, time to clear | 16 s | 16 s |
| Registrar 503 (`route-table-busy`) | 4 of 54 calls | 5 of 55 calls |
| Time to routable p50 / p95 / p99 | 23.1 / 47.1 / 58.1 s | 40.1 / 49.1 / 50.1 s |
| Time to last miss p50 / p95 / p99 | 39.0 / 57.0 / 59.0 s | 41.0 / 52.0 / 54.0 s |
| Routes served once and then refused again | not counted | 30 of 50 routes, 75 requests |
| Client latency, served `whoami`, p50 / p99 | 0.05 / 0.11 s | 0.05 / 0.11 s |
| Edge refusal latency, p50 / p99 | 4 / 9 ms | 3 / 7 ms |
| Router compute utilization, highest minute | 94 % | 94 % |
| Isolation | 0 mismatches in 4,913 assertions | 0 in 4,680 |

What the numbers say:

- A write takes half a second when alone and up to 8 s when 20 contend for the
  store's one ETag; about one call in ten ends in 503 after five attempts. The
  route hook retries those.
- A route is not seen everywhere at once. Edge locations learn a write at
  different times, up to 59 s in these runs, and a request can see a route and
  then lose it before it settles. That is longer than the 45 s the route hook
  waits for propagation. After 90 s every request saw every route.
- The router's compute utilization reaches 94 % in a minute with ordinary load,
  and 46 % in the minute of run 2's `router-load` scenario with its padded tokens; the
  metric has one point a minute, so a short scenario shares its minute with
  its neighbours and the figure is an upper bound.

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
- Slice mode only: the registrar reads a stand-in control plane, and the
  global hook role is a role of the same account. Nothing here runs the route
  hook script, the real hooks or the cell scripts, and `teardown` has never run
  `register-hooks.sh --delete` live (a slice-mode run registers no hook).
- No quota ids for CloudFront Functions compute or the API Gateway control
  plane: neither has a Service Quotas code (checked with `list-service-quotas`
  for `cloudfront` and `apigateway`), so `stress/src/budget.ts` has nothing
  to name and the slice declares only Lambda concurrency. The router's compute
  utilization is reported in the record under a key of its own.
- At most 100 tenants are seeded at any tier, and the write burst is
  `min(100, tenantsSeeded)`; only the small tier (a burst of 20) has run.
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
| `deploy.sh`, `teardown.sh`, `lib.sh` | stacks and what they leave behind |
| `../../test/stress/` | the driver: `driver.ts` (verbs), `scenarios.ts`, `classify.ts`, `sink.ts`, `recorder.ts`, `collect.ts`, `join.ts`, `clients.ts`, `sigv4.ts`, `plan.ts`; unit tests in `stress.test.ts` |
