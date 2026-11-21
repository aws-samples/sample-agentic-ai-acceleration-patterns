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

You need AWS credentials for a non-production account, with the rights to
create the stacks (an IAM role, a CloudFront distribution and web ACL, Lambda
functions, API Gateway, DynamoDB, Cognito); that account bootstrapped for the
CDK in the Region you choose and in `us-east-1`; a public hosted zone in it for
a test subdomain; and the `tenant-identity` shared-pool deployment's published
parameters (`/application-plane/shared/identity/*`) in some Region; and the
account-wide API Gateway CloudWatch Logs role in the front door's Region (the
registrar's stage writes access logs through it; set it once with `aws
apigateway update-account`, a deployment prerequisite of the front door). On the
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
| `STRESS_PREFIX` | names the stacks (`<prefix>-support`, `-control-plane`, `-edge`, `-main`, `-edge-logging`, `-cell`), the CDK construct id, the stand-in hook role (`<prefix in lower case>-global-hook`) and the application domain. `teardown` destroys every stack of the prefix, so `slice.sh` refuses `TenantFrontDoor` and `TfdSmoke` (the names of the front door's and the smoke test's own stacks), and `deploy` refuses a prefix whose stacks exist while this host has no deploy for it (the host's record of the prefix names the account it was made in, `deploy` and `teardown` refuse the credentials of another account, and a clean `teardown` clears the record) |
| `STRESS_FD_ZONE_ID`, `STRESS_FD_ZONE_NAME` | the test subdomain's hosted zone; the front door's `appDomain` is `<prefix in lower case>.<zone name>`: one name per run prefix, so two runs never share a host |
| `STRESS_FD_IDENTITY_REGION` | the Region of the `tenant-identity` shared pool when it is not `AWS_REGION` |

The stress front door uses a test subdomain zone that you supply: one
application domain per run prefix under it, passed in `STRESS_FD_ZONE_ID` and
`STRESS_FD_ZONE_NAME`. No domain is written into the repository.

## What it does

| Verb | Does |
|---|---|
| `budget` | prints the draw on Lambda concurrency (the registrar's burst plus a quarter second of the cell at the peak rate); no credentials |
| `deploy` | the smoke stacks, then the front door's three stacks one at a time, then the cell; prints `stack=<name> deploy_seconds=<n>` for each. Fails at once when another front door holds the edge parameter in this Region |
| `seed` | tenants in `tenant-identity`, each tenant's namespace parameter in the cell's Region and its records in the stand-in control plane, the cell route and the active tenants' routes written through the registrar as the global hook role, and a wait until every active route answers five times in a row. It registers the vendor scope `app/use` on the shared pool when the catalogue lacks it, and leaves it there, as a later run reuses it |
| `run <scenario>` | one scenario, one result record, one request log (below) |
| `collect` | reads the edge and cell logs and the router's metrics for each scenario's window and checks them against the driver's counts; writes the `edge` hop and the router's compute utilization into the records |
| `teardown` | the run's tenants (at `large`, only with `--fixtures`), routes and parameters (the vendor scope `app/use` stays); then the stacks, last deployed first; then a check that nothing is left. Prints `stack=<name> destroy_seconds=<n>` for each |

## Scenarios

| Id | What it sends | Pass criteria |
|---|---|---|
| `PS-7` | per round: a plain request, a token whose payload names another tenant, a client `x-tenant-route` header, a client `x-tenant-token` header, a token with a `tenants` list, a claim with no route, and a direct call to the cell's function URL | a probe that must be refused is never served; the headers the client supplies change nothing; the cell's log holds exactly the requests the driver saw reach it (the plain request, the two header probes, and the forged tokens, which the cell refuses with 403); the router refuses the `tenants` list and the unrouted claim, and IAM refuses the direct call, so none of those three reaches the cell |
| `route-write` | a burst of 20 `PutTenantRoute` calls at once, then one a second for 30 s, as the global hook role; each written tenant is watched for 90 s with one request a second, then asked ten more times | every answer names the right tenant; after 90 s every request sees its route; the registrar answers a write with 200 or 503 only. No limit on the write cycle or the time to routable until they are measured, and a 503 that survives the driver's five attempts is counted by cause, not failed |
| `router-load` | 10 requests a second for 40 s, then 40 a second for 20 s, over the active tenants; one in five carries a token padded to about 8,000 bytes that the cell refuses | no mismatch; every refusal is the cell's `403` for the padded token or its rate limit |
| `edge-refusals` | 60 each of: no token, an undecodable token, a tenant with no route, a suspended tenant, a cross-site call, an Authorization over 8,192 bytes, `/agents`; first it routes the spare tenant, suspends it and reports the time from the suspend call to five 503s in a row | every request is refused with its reason; the cell's log has no line for the window |

All four run against the smoke stack (ADR-0030), which has one cell. `PS-7` here is the
stress spec's cross-cell probe set (§5.1) as far as one cell allows: the probes
at the router, with no probe at a second cell. Platform mode is not part of this
slice.

Every answer is classified (`test/stress/classify.ts`) as served, or refused
with a reason that names the hop (`edge-no-route`, `cell-forbidden`,
`origin-iam-denied`, ...). A refusal is attributed to the tenant the request
named, or `-` when it named none, which is also what the edge log shows
(spec P-7). An answer no hop owns is an unattributed refusal and fails the
run; so does a driver-side timeout or network error (status 0), which no hop
answered. A 503 from the registrar is counted by cause: `route-table-busy`
(five ETag conflicts), `control-plane-unreadable`, or `other`.

The tokens come from `tenant-identity`'s test aid `IssueToken`; they live
5 minutes, so a scenario issues its own and issues new ones every 200 s while
it runs. Forged tokens reuse a real token's
header and signature, so the router (which never checks signatures,
ADR-0005) routes them and the cell refuses them.

## Correlation

The router can log one value with `cf.logCustomData`, and it logs the
tenant (ADR-0010). The slice adds no correlation header (ADR-0029). Every
response carries `x-amz-cf-id`, and CloudFront's standard log carries the
same value as `x-edge-request-id`, so `collect` joins each request to its
edge log line on it, and every request of the measured runs joined. The
same join gives the edge's own time (`time-taken`) as
the `edge` hop and shows that every router refusal is a
`FunctionGeneratedResponse`. The origin is joined by its counts, not per
request: the cell's log counts by status must equal the number of requests
the driver saw reach it.

`collect` writes none of the contract's late `refusals` and `cost` fields:
the driver records refusals when it sends, and the slice reads no cost. It
adds the `edge` hop to `latency`, and the router's highest compute
utilization of the scenario's minutes to `quotas.platform` under
`cloudfront-function-compute-utilization-pct`, a key that is not a budgeted
quota. The runner accepts both because it re-hashes the slice's own records
after `collect`. Each scenario waits up to 5 minutes for its own edge logs and
up to 5 for the cell's; the cell's counts must agree with the driver's and
stay unchanged for 30 s (a minute when no request should reach the cell). A
router error metric with no datapoint counts as zero errors when the router's
invocations were counted for the same minutes, and is reported as not checked
when they were not.

## Measured (small tier)

The ranges of three runs from a non-production test account: front door in
one Region, `tenant-identity` in another, edge in us-east-1, one driver host.
Latencies include the driver host's network path to CloudFront. The time to
routable and the time to the last miss are seconds from the registrar's answer
to a write, to the first answer that serves the route and to the last one that
does not.

| Measure | Range over three runs |
|---|---|
| Registrar write cycle p50 | 0.50 to 0.51 s |
| Registrar write cycle p95 / p99 | 7.2 to 7.8 s / 8.2 to 8.6 s |
| Burst of 20 writes at once, time to write them all | 15 to 16 s |
| Registrar 503 (`route-table-busy`) | 4 or 5 of 54 or 55 calls |
| Time to routable p50 / p95 / p99 | 23 to 40 s / 37 to 49 s / 38 to 58 s |
| Time to last miss p50 / p95 / p99 | 34 to 41 s / 52 to 57 s / 54 to 60 s |
| Routes served once and then refused again | 29 or 30 of 50 routes |
| Suspend call to five 503s in a row | 30 to 60 s |
| Client latency, served `whoami`, p50 / p99 | 0.05 s / 0.11 to 0.12 s |
| Edge refusal latency, p50 / p99 | 3 to 4 ms / 7 to 9 ms |
| Router compute utilization, highest minute | 94 % |
| Isolation | 0 mismatches in 4,680 to 5,120 assertions |
| Unattributed refusals | 0 |

Deploy and destroy time, seconds, of one clean deploy and one teardown. A
teardown that sweeps 71 tenants adds about 6.5 minutes before the stacks go:

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
  for the store's one ETag; about one call in twelve is answered 503 after the
  registrar's five store attempts. The route hook retries those, as the driver
  does. The 15 to 16 s the burst took
  includes the driver's own wait (about 5 s) before it retries a 503, so it is
  an upper bound on the store's time, not its throughput.
- A route is not seen everywhere at once. Edge locations learn a write at
  different times, up to 60 s in the measured runs, and a request can see a route and
  then lose it before it settles. That is longer than the 45 s the route hook
  waits for propagation. A suspension took 30 to 60 s after the call to show
  as five 503s in a row. After 90 s every request saw every route.
- The router's compute utilization reaches 94 % in a minute with ordinary
  load. The highest minute was 94 % for `PS-7`, `route-write` and
  `router-load` and 40 % for `edge-refusals`. The metric has one point a
  minute, so a short scenario shares its minute with its neighbours and each
  figure is an upper bound; it cannot show whether the padded tokens of
  `router-load` cost more than ordinary ones.

## Known limitations

- **One front door per Region, fixed SSM name.** The front door publishes
  `/application-plane/shared/front-door/edge`, a name with no prefix. A second
  front door in a Region and account fails at the parameter, and `deploy`
  refuses to start when it finds the parameter. Pick a Region with no front
  door and set `STRESS_FD_IDENTITY_REGION` when `tenant-identity` is in
  another one. A platform run needs a Region of its own for its front door.
- CloudFront policy names and other account-wide names derive from the CDK
  construct id, so `src/main.ts` takes the id from `stackNamePrefix`; two
  front doors in one account need different prefixes as well as different
  Regions.
- The front door's issuer endpoints (authorize, token and logout) are
  placeholders on a reserved example domain, because the run signs nobody in:
  `/config.json` of the stress front door cannot be used to sign in, and the
  SPA is not exercised.
- `route-write` writes the routes of the first write tenants (the burst plus
  the sustained writes: 50 at `small`) and measures how long each takes to
  reach the edge. A second run on the same stacks finds
  those routes already there and measures nothing, so each deploy supports one
  `route-write`.
- Slice mode only: the registrar reads a stand-in control plane, and the
  global hook role is a role of the same account. Nothing here runs the route
  hook script, the real hooks or the cell scripts, and a slice-mode run
  registers no hook on any control plane, so `teardown` unregisters none.
- No quota ids for CloudFront Functions compute or the API Gateway control
  plane: neither has a Service Quotas code (checked with `list-service-quotas`
  for `cloudfront` and `apigateway`), so `stress/src/budget.ts` has nothing
  to name and the slice declares only Lambda concurrency. The router's compute
  utilization is reported in the record under a key of its own.
- At most 100 active tenants and a write burst of `min(100, tenantsSeeded)`;
  the measurements above are of the small tier (a burst of 20). At `medium`
  and `large` a scenario that outlasts 5 minutes relies on the token refresh,
  which the small tier does not exercise for that long, and `large`'s tenants
  stay between runs while its stacks
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
| `deploy.sh`, `teardown.sh`, `lib.sh` | stacks and what they leave behind |
| `../../test/stress/` | the driver: `driver.ts` (verbs), `scenarios.ts`, `classify.ts`, `sink.ts`, `recorder.ts`, `collect.ts`, `join.ts`, `clients.ts`, `sigv4.ts`, `plan.ts`, `http.ts`, `load.ts`, `state.ts`; unit tests in `stress.test.ts` and, for the guards of `slice.sh`, `slice-guards.test.ts` |
