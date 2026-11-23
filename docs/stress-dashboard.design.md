<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Platform stress test: a CloudWatch dashboard for a run

- Status: Proposed (design only; no code, nothing deployed)
- Date: 2026-11-23
- Decision record: [stress ADR-0022](../stress/adr/0022-show-a-run-on-one-dashboard-in-the-platform-account.md)
- Builds on: [`docs/stress-test.spec.md`](./stress-test.spec.md) (§4.3 result
  records, §4.4 quota budget, §5 scenarios, §6 observability, §7 pass criteria)
  and [`stress/README.md`](../stress/README.md)

"Spec" below means `docs/stress-test.spec.md`. "The run's Region" is the Region
every stack but the edge uses. "Cell account" is a standalone account that
holds cells only (spec §3.7).

## Frame

### The decision

Where does a person look to see a stress run live and after it, and how do the
platform account, the cell accounts, the edge in `us-east-1` and the driver host
feed that one place?

Today a run's numbers show only in the result records and the results file,
after the run ends (spec §4.3). In platform mode the runtime-isolation slice
joins no hop log and no metric, so its records hold the client's latency hops
and no quota peaks or cost (`stress/README.md`, known limitations).

### Options

| # | Option | Verdict |
|---|---|---|
| 1 | One dashboard in the platform account. Cell accounts share metrics through cross-account observability (a sink in the platform account, one link per cell account). The edge is read by Region in the same account. | Recommended |
| 2 | One dashboard in the platform account, cell accounts reached through the cross-account console roles | Metrics only; a role in every cell account; no programmatic access |
| 3 | One dashboard per account | Needs a new stack kind and a deploy right in each cell account; three consoles to follow one request |
| 4 | Republish cell metrics into the platform account from the runner | A cell-account role to review, a poll loop to keep correct, a copy of the data |
| 5 | Managed Grafana, or Logs Insights widgets only | A workspace and roles to remove again; per-scan charges on every refresh |

The full comparison is in the ADR.

### Success criteria

| # | Criterion | How it is checked |
|---|---|---|
| 1 | Within about three minutes of a scenario starting, a person sees its request rate, refusals by reason, isolation mismatches (expected 0), per-hop latency and the headroom of the quota that gives out first | a `small` run, watched live (unproven, see §14) |
| 2 | After the run, a person sees the same run again, from the metrics, with no run-time state | redeploy by run id, and the PNG snapshots of the run folder |
| 3 | No metric carries a tenant, user, agent or token as a dimension | a unit test of the emitter's dimension allowlist (§3) |
| 4 | A cell account gains one link and no other stack kind | the account check of spec §3.7 passes with the link (unproven) |
| 5 | After teardown the run leaves nothing a person must delete: no stack, log group, role or alarm | the runner's leftover check (§8) |
| 6 | A run costs under $0.50 for the dashboard and its metrics, and an idle dashboard under $3 a month | `cost.sh` against a quiet day (§10, estimates at list price, unverified) |
| 7 | Deploy and destroy of the dashboard are timed and reported next to the slices' (spec P-6) | the lifecycle record |

### Risks

| Risk | What it would do | Where it is handled |
|---|---|---|
| The link breaks the account check of spec §3.7, or the cell owner cannot create it | the cell side of the dashboard stays empty | spike S-1 (§12); fallback is the republish option (ADR option 4) |
| A cell build publishes false numbers into `StressCell` | the dashboard shows a clean run that was not | the dashboard never decides pass or fail; the record stays the record (§1) |
| The driver and the dashboard disagree | a person trusts the wrong one | the reconciliation widget D6 sets driver count against cell count (§4) |
| k6's output lines arrive late or not at all | the live view lags or goes blank | the record still holds the run; the relay's lag is measured in spike S-2 |
| Metric names this repository has never read do not exist as assumed (CodeBuild, Cognito, AgentCore, CloudFront on a multi-tenant distribution) | a widget stays empty | §14 lists them; spike S-3 checks each before a widget is built |

### The question the reader did not ask

*Can the dashboard be wrong, and which wins when it disagrees with the
record?*

Yes, and the record wins. The isolation count the dashboard shows comes from the
same driver that makes the record's count (§5), so the dashboard cannot catch a
driver bug. What it adds is a second view of the request count from the cell's
own logs (widget D6), which can. It also shows the dashboard's own gaps: the
live "unattributed" figure is a driver-side estimate until `collect` writes the
final one (§5). A person reads the dashboard to steer a run, and reads the
results file to judge it.

## 1. What the dashboard is, and is not

| It is | It is not |
|---|---|
| A live and after-the-run view of one run, built from metrics | A pass or fail gate. The pass criteria stay in spec §7 and in the records |
| One CloudWatch dashboard in the platform account, with nothing else in its stack | A per-tenant view. Per-tenant metrics stay off (§7) |
| A test asset like the driver host: deployed by the runner, removed at teardown | Part of any sample's deployed stacks |
| A place where the driver's count and the cell's count sit side by side | A replacement for the per-hop join on the correlation id (spec §6, stress ADR-0005), which stays a `collect` step |

## 2. Where it lives, and how each place feeds it

```
 driver host (platform account) ──PutMetricData──► StressRun (platform account, run's Region)
 runner (marker, lifecycle, records) ─────────────► StressRun

 platform account, run's Region:  AWS/CodeBuild, AWS/Lambda, AWS/ApiGateway, TenantFrontDoor, ...  (native)
 platform account, us-east-1:     AWS/CloudFront router and distribution                          (widget region)

 cell account 1 ──link──┐
 cell account 2 ──link──┴──► sink in the platform account (run's Region) ─► AWS/Lambda,
                              StressCell (metric filters on the cell's own logs)

                 one dashboard `<prefix>-run`, platform account, run's Region
```

| Source | Account | Region | Reached by | Who sets it up | Idle cost |
|---|---|---|---|---|---|
| `StressRun` (the driver's and the runner's counts) | platform | run's Region | `PutMetricData` from the driver host and the runner | the runner (code in `stress/`) | none |
| Control plane, registrar, identity API, route table | platform | run's Region | native metrics, searched by name prefix | nothing to set up | none |
| Router and distribution | platform | `us-east-1` | native metrics, a widget with `region` set | nothing to set up | none |
| Ingress, authoriser, API Gateway status, Lambda, SDK retries | each cell account | run's Region | the sink and one link per cell account | the account owner, once (§6) | none |

Cross-account observability works inside one Region: a sink and a link exist
per Region, and each account holds one sink per Region
([CloudWatch cross-account observability](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html),
[the methods compared](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Cross-Account-Methods.html)).
That fits this platform: the only cross-Region source is the edge, and the edge
is in the platform account, which reads its own `us-east-1` metrics with no
sharing. Cell accounts hold their cells in the run's Region only. A cell
account in a second Region needs its own link and a sink in that Region, or
the cross-account console option, and is not designed here (`stress/README.md`
lists a second Region as unproven).

The dashboard cannot name cell resources, because it is deployed before the
first cell exists and the platform account cannot read a cell's stack outputs.
So every cell widget uses either an account-wide metric with no dimension
(`AWS/Lambda` `Throttles`, `ConcurrentExecutions`, `Errors`) or a `StressCell`
metric that the cell publishes under a fixed name (§3). The dashboard needs
the cell accounts' ids, and nothing else of the cells. Account ids are a
stack parameter of the dashboard and appear in no file of the repository.

## 3. Metrics the dashboard reads

### 3.1 `StressRun`, published into the platform account

One namespace, standard resolution (60 s). The emitter has an allowlist of
dimension names; any other name is an error, and a unit test proves it.

| Dimension | Values |
|---|---|
| `RunId` | the run id (`STRESS_RUN_ID`) |
| `Slice` | a slice name |
| `Scenario` | a scenario id (`PS-1` to `PS-8`, or a slice scenario) |
| `StatusClass` | `2xx`, `3xx`, `4xx`, `5xx`, `none` |
| `Phase` | `deploy`, `destroy` |
| `Account` | `platform`, `cell-account-<n>` (the budget's labels, never the id) |
| `Quota` | a quota id of `stress/src/budget.ts` |
| `Reason` | the record's refusal reasons (`http-<status>`, `tool-<status>`, or the body's own reason), at most 16 values, any other mapped to `other` |

Never a tenant id, user name, agent id, token, host name or address.

| Metric | Unit | Dimensions | Published by, and when |
|---|---|---|---|
| `ScenarioActive` | Count (1 or 0) | `RunId`, `Scenario` | runner: 1 every 60 s while a scenario's `run` verb runs, 0 when it ends |
| `IsolationAssertions`, `IsolationMismatches` | Count | `RunId`, `Slice`, `Scenario` | host relay, live for k6 scenarios; runner, from each record when `run` returns (every slice, no slice code) |
| `Requests` | Count | `RunId`, `Scenario`, `StatusClass` | host relay |
| `RefusalsSeen`, `RefusalsNamed` | Count | `RunId`, `Scenario` | host relay: every 4xx or 5xx the driver counted, and those whose line names a tenant and a reason |
| `RefusalsByReason` | Count | `RunId`, `Scenario`, `Reason` | host relay |
| `RefusalsUnattributed` | Count | `RunId`, `Slice`, `Scenario` | runner, from the record after the slice's `collect` (the final figure, spec P-7) |
| `ClientLatencyMs` | Milliseconds | `RunId`, `Scenario` | host relay, as a histogram (`Values` and `Counts`), so CloudWatch gives p50, p95 and p99 |
| `OnboardReadySeconds` | Seconds | `RunId` | control-plane driver: one value per tenant (PS-1, spec §5.1) |
| `BuildsInFlight` | Count | `RunId` | control-plane driver: the builds it has started and not seen end, every 15 s (it already paces waves at the build limit, stress ADR-0013) |
| `RoutableSeconds`, `SuspendedSeconds`, `RemovedSeconds` | Seconds | `RunId` | control-plane driver (PS-5): one value per churn tenant |
| `LifecycleSeconds` | Seconds | `RunId`, `Slice`, `Phase` | runner: after each slice's `deploy`, `teardown` and platform step |
| `QuotaPlannedDraw`, `QuotaLimit` | Count | `RunId`, `Account`, `Quota` | runner: from the budget's sums and the `--limits` file, at the start and every 60 s |

Two CloudWatch rules shape how the dashboard names these series
([metrics concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html),
[`PutMetricData`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricData.html)):

- CloudWatch does not aggregate across the dimensions of a custom metric. A
  total over all scenarios needs either a metric math sum of the named series or
  a series published without the dimension. So the dashboard stack takes the
  run's plan (the slices and scenarios the runner has already resolved) and names
  every series it draws, and the cell filters publish a total with no dimension
  beside each breakdown.
- A new metric can take up to 15 minutes to appear in `ListMetrics`, which
  `SEARCH` expressions use. A live widget on a series that is new in this run
  (every `StressRun` series, because `RunId` is new) names its metrics
  explicitly and does not search. Searches are used only for native metrics that
  exist long before the load starts (the router, the CodeBuild projects, the
  identity API).

The runner writes a record's totals when `run` returns, so its timestamps are
minutes old. A data point three to 24 hours old can take up to two hours to
become readable, and one older than a day at least 48 hours, so the runner does not
backfill a finished run.

### 3.2 `StressCell`, published in each cell account

Metric filters on the cell's own structured log lines (the field names are the
ones `collect.sh` queries today). The stress cell app adds them
(`stress/application/cell-app.ts`, which already builds the sample's stack
and reaches its log groups by construct id, as the sample's own Contributor
Insights rules do). The runtime-isolation sample does not change. A metric
filter takes up to three dimensions from JSON fields, so a filter cannot make
the cell publish a tenant dimension unless its author writes one; the stress
cell app's unit test asserts none does.

| Metric | Unit | Dimension | Log group, filter, value |
|---|---|---|---|
| `IngressRequests` | Count | `Status` (`$.status`), and a total with none | API access log, every line, value 1 |
| `IngressServedMs`, `IngressTtfbMs` | Milliseconds | none | ingress log, `request served`, value `$.totalMs` and `$.ttfbMs` |
| `IngressRefused` | Count | `Reason`, `Status`, and a total with none | ingress log, `request refused`, value 1 |
| `AuthorizerRefused` | Count | `Reason`, `Status`, and a total with none | authoriser log, `request refused`, value 1 |
| `SdkRetryLines` | Count | `Service` (`$.service`), and a total with none | ingress log, `sdk retried`, value 1 |
| `MintLookups` | Count | `Mint` (`$.mint`) | ingress log, `request served`, value 1 |

The dashboard names the `Status`, `Reason`, `Service` and `Mint` values it
draws (the statuses the ingress returns, the refusal reasons and `mint` values
that the sample's code logs, and the SDK services `sts`, `kms` and `dynamodb`). A value outside the list
shows in the total and not in the breakdown.

`SdkRetryLines` counts the calls that the SDK retried, not the retries
(`attempts - 1` in the log line, which a filter cannot compute). It is a
signal that a quota is near, not a measure of it.

### 3.3 Native metrics

| Source | Namespace | Read today by |
|---|---|---|
| Router | `AWS/CloudFront`, `FunctionComputeUtilization`, `FunctionInvocations`, `FunctionExecutionErrors`, `FunctionThrottles`, `FunctionValidationErrors`; dimensions `FunctionName`, `Region=Global`; in `us-east-1` | front-door slice `collect` (`test/stress/collect.ts`) |
| Account Lambda | `AWS/Lambda` with no dimension: `ConcurrentExecutions`, `Throttles`, `Errors`, `Invocations` | runtime-isolation `collect.sh` (`account-concurrency`) |
| Identity API | `AWS/ApiGateway` `Count`, `4XXError`, `5XXError`, dimension `ApiName` | tenant-identity driver (`apiSum`) |
| Route table | `TenantFrontDoor`, `RouteTableBytes`, dimension `DistributionId` | the front door's own alarm (80 % of the 5 MB store) |
| Control plane builds | `AWS/CodeBuild` `Builds`, `FailedBuilds`, `Duration`, `QueuedDuration`; dimension `ProjectName` | no slice reads these today |
| Control plane workflow | `AWS/States` `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionThrottled` | no slice reads these today |
| Distribution | `AWS/CloudFront` `Requests`, `4xxErrorRate`, `5xxErrorRate`; dimensions `DistributionId`, `Region=Global` | no slice reads these today |

Rows that "no slice reads today" are unproven: §14.

## 4. Widget list

Every widget has a metric, a namespace, dimensions, a statistic, a period and the
scenarios it serves. Periods are 60 s except where stated. "Live" means the data
arrives while the scenario runs; "after" means at the end of the scenario or the
run. Scenario ids are those of spec §5. Slice scenarios: runtime-isolation S1 to
S7, control-plane placement races, read rate and build-limit scaling,
tenant-identity token issue and `CreateTenant` under throttling, front-door
route-write, router-load and edge-refusals.

### A. The run (platform account, `StressRun`)

| ID | Widget | Metric (namespace `StressRun`) | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| A1 | Run header: run id, tier, commits (text) and the scenario strip | `ScenarioActive` | `RunId`, `Scenario` | Maximum | every scenario | live |
| A2 | Isolation: assertions per minute, and a single value for mismatches that turns red above 0 | `IsolationAssertions`, `IsolationMismatches` | `RunId`, `Slice`, `Scenario` | Sum | P-1 for PS-1 to PS-8, S1 to S7 | live (k6), after (others) |
| A3 | Refusals: seen against named, their gap, and the final unattributed count | `RefusalsSeen`, `RefusalsNamed`, math `seen - named`, `RefusalsUnattributed` | `RunId`, `Scenario` | Sum | P-7 for PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7 | live (gap), after (final) |
| A4 | Requests by status class | `Requests` | `RunId`, `Scenario`, `StatusClass` | Sum | PS-2 to PS-8 | live |
| A5 | Refusals by reason | `RefusalsByReason` | `RunId`, `Scenario`, `Reason` | Sum | PS-4 (noisy neighbour), PS-3 (herd), PS-8 | live |
| A6 | Client latency p50, p95, p99 | `ClientLatencyMs` | `RunId`, `Scenario` | p50, p95, p99 | PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7 | live |
| A7 | Onboarding: ready time p50 and p95, and builds in flight against the build limit | `OnboardReadySeconds`, `BuildsInFlight` | `RunId` | p50, p95; Maximum | PS-1, control-plane build-limit scaling | live |
| A8 | Churn: time to routable, to suspended, to removed | `RoutableSeconds`, `SuspendedSeconds`, `RemovedSeconds` | `RunId` | p50, p99 | PS-5, front-door route-write | after (per tenant, as they finish) |
| A9 | Deploy and destroy seconds per slice (table) | `LifecycleSeconds` | `RunId`, `Slice`, `Phase` | Maximum | P-6, every run | after each verb |

### B. The edge (platform account, `us-east-1`)

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| B1 | Router compute utilisation (percent), with a line at 100 | `AWS/CloudFront` `FunctionComputeUtilization` | `FunctionName`, `Region=Global` | Maximum | PS-2, PS-5, PS-7, router-load. The front-door slice measured 94 % in a minute at `small` | live |
| B2 | Router errors and throttles | `FunctionExecutionErrors`, `FunctionThrottles`, `FunctionValidationErrors`, and `FunctionInvocations` for scale | same | Sum | PS-2 to PS-8, edge-refusals | live |
| B3 | Distribution requests and error rates | `AWS/CloudFront` `Requests`, `4xxErrorRate`, `5xxErrorRate` | `DistributionId`, `Region=Global` | Sum; Average | PS-2 to PS-8 | live (unproven for this distribution type) |
| B4 | Route table bytes against the store's cap (80 % line) | `TenantFrontDoor` `RouteTableBytes`, in the run's Region | `DistributionId` | Maximum, 300 s | PS-1, PS-5 at `large` (4,000 routes) | live |

B1 to B3 find the router and the distribution by search in `us-east-1` (one front
door per account and Region, `stress/README.md`), because the dashboard is
deployed before the front door.

### C. The platform account

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| C1 | Builds: started, failed, queued time, duration | `AWS/CodeBuild` `Builds`, `FailedBuilds`, `QueuedDuration`, `Duration` | `ProjectName`, by search on the fleet prefix | Sum; Average | PS-1, control-plane scenarios | live (unproven) |
| C2 | Control-plane workflow executions | `AWS/States` `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionThrottled` | `StateMachineArn`, by search on the fleet prefix | Sum | PS-1, PS-5, control-plane scenarios | live (unproven) |
| C3 | Identity API: calls and errors | `AWS/ApiGateway` `Count`, `4XXError`, `5XXError` | `ApiName`, by search | Sum | PS-1 (identity calls), identity scenarios | live |
| C4 | Lambda account-wide: concurrency, throttles, errors | `AWS/Lambda` `ConcurrentExecutions` (Maximum), `Throttles`, `Errors` (Sum) | none | as listed | PS-1, PS-5, route-write | live |

### D. The cell accounts (one set per cell account, through the link)

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| D1 | Ingress requests by status | `StressCell` `IngressRequests` | `Status` | Sum | PS-2 to PS-8, S1 to S7 | live |
| D2 | Ingress latency p50, p95, p99 and TTFB | `StressCell` `IngressServedMs`, `IngressTtfbMs` | none | p50, p95, p99 | PS-2, PS-3, PS-6, PS-8, S1, S2, S5, S6 | live |
| D3 | Refusals by reason, ingress and authoriser | `StressCell` `IngressRefused`, `AuthorizerRefused` | `Reason`, `Status` | Sum | PS-3, PS-4, PS-8, S2, S3, S6 | live |
| D4 | Lambda in the cell account: concurrency, throttles, errors | `AWS/Lambda` `ConcurrentExecutions` (Maximum), `Throttles`, `Errors` | none | as listed | PS-3 (herd), PS-8 (peak), S2, S6 | live |
| D5 | SDK retried calls by service, and mint lookups | `StressCell` `SdkRetryLines` by `Service`; `MintLookups` by `Mint` | `Service`; `Mint` | Sum | PS-3 (STS and KMS), PS-8 | live |
| D6 | Reconciliation: the driver's 2xx against the cell's 200, and the gap | `StressRun` `Requests` (`2xx`) against `StressCell` `IngressRequests` (`Status` 200), math difference | as above | Sum | PS-2, PS-3, PS-6, PS-8 | live |
| D7 | Top tenants by requests, errors, backend seconds, output tokens | the cell's four Contributor Insights rules (runtime-isolation ADR-0021) | rule | Sum | PS-4 (the noisy tenant), PS-8 | live (cross-account support unproven) |

D6 is the widget that can show the driver wrong. A persistent gap that the edge's
refusals (B2) do not explain is a finding. In PS-2, PS-3, PS-6 and PS-8 every
agent call that the edge accepts reaches the one cell's ingress at `small`
(stress ADR-0016). At `medium` and `large` D6 waits for Q-7.

### E. Quota headroom (§6)

| ID | Widget | Metric | Serves | When |
|---|---|---|---|---|
| E1 | One panel per budgeted quota with a signal: planned draw, limit and the observed peak (§6) | `StressRun` `QuotaPlannedDraw`, `QuotaLimit`; the signal named in §6 | PS-3, PS-8, and PS-1 for builds | live |
| E2 | The first quota to give out: a table of quota, account, peak as a percent of the limit, sorted | math over E1 | PS-8 (spec §5.1 "the first quota that gives out") | after |

The free allowance is three dashboards of up to 50 metrics each. This
dashboard names more than 50 series, because every `StressRun` metric is named
once for each scenario of the plan and the cell widgets repeat for each cell
account, so it is billed (§10).

### Where each scenario is watched

| Scenario | Widgets |
|---|---|
| PS-1 onboarding | A7, A9, C1, C2, C3, C4, E1 (CodeBuild and Cognito rows) |
| PS-2 steady | A2, A4, A6, B1, B2, D1, D2, D6 |
| PS-3 herd | A3, A5, A6, D3, D4, D5, E1 (Lambda, STS, KMS) |
| PS-4 noisy neighbour | A5, D3, D7 |
| PS-5 churn | A8, B1, B4, C2 |
| PS-6 long streams | A6, D2 (TTFB), D6 |
| PS-7 cross-cell probes | A2, B1, B2 |
| PS-8 peak | A3, A5, D3, D4, D5, E1, E2 |
| Slice scenarios | the same widgets as the platform scenario of the same shape |

## 5. Isolation mismatches and unattributed refusals

The two counts are the test's pass criteria (spec §7). They reach CloudWatch by
two paths, a live one and a final one.

| Count | Live path | Final path |
|---|---|---|
| Isolation assertions and mismatches | k6's own lines. The k6 library keeps one counter per assertion and prints a line per mismatch (`isolation_mismatch`, `stress/k6/lib.js`). A relay on the driver host reads k6's output file, sums by minute, and calls `PutMetricData`. | The runner reads each record when `run` returns and publishes its `isolation` totals with the scenario's window. This covers every slice, k6 or not, with no slice code. |
| Refusals seen and named | The k6 library prints a line for each refusal that names a tenant and a reason (`edge_refusal`, `body_refusal`) and counts every 4xx and 5xx (`refusals_seen`). The relay publishes `RefusalsSeen` and `RefusalsNamed`. Their gap is a live estimate of the unattributed count. | The slice's `collect` joins the driver's lines with the hops' logs and writes `refusals.unattributed` into the record (spec §4.3, P-7). The runner publishes it as `RefusalsUnattributed`. The final figure replaces the estimate on A3. |

The relay is a short bash and `jq` script that `stress/driver/k6.sh` starts on the
host before k6 and stops after it, beside the file `k6.sh` already keeps
(`/opt/stress/out/k6-stdout.txt`). It needs two changes to existing code:

1. The k6 library flushes one more line per VU per minute (the existing
   `tenant_minute` ledger flushes the same way): the count by status and a
   latency histogram in fixed buckets. The relay sums the lines of all VUs for a
   minute and publishes the minute once every VU has passed it, or after a grace
   of 90 s.
2. The driver host role gains `cloudwatch:PutMetricData`, limited by the condition
   key `cloudwatch:namespace` to `StressRun`. The action has no resource type, so
   the statement's resource is `*`, as for the Run Command actions (stress
   ADR-0009).

The live view therefore trails the run by the minute plus the grace plus
CloudWatch's own delay. That is unmeasured; spike S-2 measures it. The cost of
the live path is one `PutMetricData` call a minute on the host.

What the dashboard cannot show live: edge overhead as the spec defines it (client
time to first byte minus ingress time to first byte, joined per request on the
correlation id, spec §6). A2 to A6 and D2 show the two sides as separate
percentiles, which is an approximation. The per-request join stays in `collect`.

## 6. Quota headroom against the quota budget

The runner already adds each slice's `budget` per account and refuses to start
over a quota (spec §4.4, `stress/src/budget.ts`). It publishes the sums
(`QuotaPlannedDraw`) and the limits it checked against (`QuotaLimit`, from the
`--limits` file) once at the start and every 60 s, with the budget's account
labels. The dashboard draws the planned draw and the limit as lines, and the
observed peak where a signal exists.

| Quota id | Signal on the dashboard | Where | Gap |
|---|---|---|---|
| `lambda-concurrency` | `AWS/Lambda` `ConcurrentExecutions`, Maximum, no dimension | C4, D4 | none; read today |
| `codebuild-linux-small` | `BuildsInFlight` from the control-plane driver | A7 | CodeBuild publishes no concurrency metric that this design found; the driver's own count stands in (unproven) |
| `sts-assume-role-rps` | `SdkRetryLines` for `Service` `sts` | D5 | STS publishes no rate metric; the signal is that calls were retried, not the rate or the percent of 600 |
| `kms-rsa-rps`, `kms-ecc-rps` | `SdkRetryLines` for `Service` `kms` | D5 | the same: a retry signal only |
| `agentcore-new-sessions-rps`, `agentcore-active-sessions`, `agentcore-runtime-tps` | none designed | none | the AgentCore metric names were not checked (§14); the planned draw shows alone |
| `cognito-groups` | the planned draw against the 10,000 hard cap | E1 | a count of groups is no metric; the cap is shown, not the use |
| `cognito-user-authentication-rps` | Cognito's own throttle metric, if it exists as assumed | C3, E1 | unproven (§14) |
| not budgeted today: API Gateway control plane, CloudFront Functions compute, KeyValueStore size | `FunctionComputeUtilization` (a percent already), `RouteTableBytes` | B1, B4 | the API Gateway control plane has no signal; the budget has no id for these (`stress/README.md`) |

E2 ranks the quotas by observed peak over limit. Where a quota has a retry
signal and no rate, E2 shows "retried" and not a percent. A quota with no signal
is listed as "no signal", so a person does not read an empty panel as headroom.

## 7. Per-tenant metrics policy

Per-tenant custom metrics stay opt-in and off (runtime-isolation ADR-0021: about
nine metrics a tenant and ingress, so 4,000 tenants are about 36,000 custom
metrics, and 10,000 about 90,000, roughly $11,000 a month at list price in
that ADR, unverified). The stress cell app does not set `perTenantMetrics`, and
this design does not change that.

- No tenant, user or agent dimension in `StressRun` or `StressCell`. The emitter
  rejects it, and the cell app's test asserts the filters carry none (§3).
- At `small` and `medium`, a person who needs a tenant reads the top tenants from the
  Contributor Insights rules the cell already has (D7): they are billed per rule
  and per matched log event, not per tenant. That D7 works across accounts is
  unproven; if it does not, the top-N comes from the Logs Insights queries `collect`
  already runs, once per scenario, written into the results file.
- At `large` (up to 1,000 active tenants and 1,025 cell slots), the same two
  sources apply and nothing per tenant is added. The records' `refusals.byTenantReason`
  stays the per-tenant answer. Dashboard widgets show the 10 largest only.
- The dashboard is not committed or shared outside the account, so tenant
  identifiers that D7 shows are the test's synthetic ones. The results file
  is committed and stays free of them (the redaction check in `collect.sh`).

## 8. Who deploys it, deploy and destroy time, leftovers

### Who does what

| Part | Owner | When | Removed by |
|---|---|---|---|
| Sink in the platform account | the platform account owner | once per account and Region | the owner, when the stress test is retired |
| Link in each cell account's account base | the cell account owner (the same step as the ingress reader role, spec §3.7, W-11) | once per cell account and Region | the owner, with the account base |
| Dashboard stack `<prefix>-dashboard`, one `AWS::CloudWatch::Dashboard` named `<prefix>-run` | the runner, with the platform account credentials the run already holds | after `budget` passes, before the first slice `deploy` | the runner, after the last slice `teardown`, unless `--keep-dashboard`; `--remove-fixtures` removes a kept one |
| Metric filters | the cell stack, built by the cell script | with each cell | the cell's own delete |
| Relay | `stress/driver/k6.sh`, on the driver host | for the length of one k6 run | `k6.sh`, when the remote script ends |
| Host role statement | the driver stack | with the driver | the driver's teardown |

The dashboard stack has no function, role, API, log group or custom resource, so
it creates nothing that CloudFormation does not delete with it. CDK's dashboard
construct adds none of these. This matters because of what does leak in the
platform account, named here so a reader checks for them after a run:

| Leaks today (control-plane slice; `samples/control-plane/README.md`, Known issues) | Does the dashboard add one? |
|---|---|
| The REST API's CloudWatch Logs role that the control-plane stack retains on destroy | No: no API Gateway in the dashboard stack |
| Log groups named after the stacks (API Gateway execution logs, Lambda log groups) | No: no API or function in the dashboard stack. The relay is a process on the existing host and writes no log group |
| IAM roles named `<fleet>-*` | No: the dashboard stack creates no role. The host role gains one statement and goes with the driver |

What a run does leave, and cannot remove: custom metric data points in `StressRun`
and `StressCell`. CloudWatch cannot delete a metric; it expires with its retention.
It costs nothing while nothing is sent (§10). The runner's leftover check adds
three lines: the dashboard `<prefix>-run` is gone, the stack `<prefix>-dashboard`
is gone, and no `AWS::Logs::MetricFilter` of the `StressCell` namespace remains
in a cell account whose cells are deleted.

### Deploy and destroy time

Not measured. A stack with one dashboard resource should create and delete in
well under a minute, and the sink and link in seconds. Those are expectations,
not results. The spike S-3 deploys the dashboard stack and the link, times each
with the runner's own timer, and the dashboard's two numbers go into the
lifecycle record as slice `dashboard` and then into the results file's deploy and
destroy table (spec P-6). A dashboard that takes minutes to remove is a finding.

The dashboard is deployed before the first slice, so it never delays a slice, and
removed after the last. In a platform run it adds its two times to the run's wall
clock, which at `small` is about 90 minutes (`stress/results/2026-11-21-small.md`).

## 9. Annotations, and the view afterwards

### Annotations

| What | How |
|---|---|
| Run id, tier, commits | A text widget (A1) filled from stack parameters at deploy |
| Scenario start and end | `ScenarioActive` (A1's strip): 1 each minute while the scenario's `run` verb runs, 0 at its end, so each scenario is a labelled band on every widget's time axis. The runner publishes it |
| The window of each scenario | in the results file, as a "Dashboard window" line with the start and end in UTC from the record, and a link built from the dashboard name and the Region only. The link holds no account id |
| Deploy and destroy marks | `LifecycleSeconds` (A9), by slice and phase |

Static vertical annotations in the dashboard body would need the runner to rewrite
the body at each scenario boundary. That is a `PutDashboard` call outside the stack
that CloudFormation then overwrites on update, so it is not used.

### The view afterwards

The stack is removed at teardown, but the metrics are not: they keep their
retention in their accounts, and the sink and links remain. So a run is seen again in two
ways.

1. `run.sh dashboard up --run <id>` deploys the same stack for a past run, with the
   run id and the window from the committed results file. The widgets filter on
   `RunId`. Cell widgets have no run id (the cell's filters cannot know it) and
   use the window. If the dashboard supports a `RunId` variable on a dimension,
   one dashboard can serve any run; that is unproven, and redeploying with the id is
   the fallback.
2. Before removal, the runner saves a PNG of each widget for the run's window
   (`GetMetricWidgetImage`) into the run folder outside the repository
   (`$STRESS_HOME/<prefix>/<run id>/dashboard/`). They are not committed: D7 can
   show tenant identifiers.

Metric retention is the limit: one-minute points are kept 15 days, five-minute
points 63 days, one-hour points 15 months
([CloudWatch metrics concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html)).
A run older than 15 days is seen at five-minute resolution, which hides a 5-second
herd (PS-3). The PNGs are the record of such a run at one-minute resolution.

## 10. Cost per run and idle

All figures are list-price estimates, not measurements, and prices differ by
Region. The first run measures them: `cost.sh` reads the CloudWatch line for the
run day against a quiet day (it exists for runtime-isolation; the platform run
needs the same call, work item W-12g).

| Item | Basis | Per run (about 3 hours) |
|---|---|---|
| Dashboard | about $3 a dashboard-month, prorated by the hour; the first three dashboards of up to 50 metrics are free, this one has more | about $0.01 |
| `StressRun` series | about 150 series (§3.1) at $0.30 a series-month, charged only for the hours in which data is sent | about $0.18 |
| `StressCell` series | about 25 series for each of two cell accounts, same basis | about $0.06 |
| Metric filters | no charge for the filter itself | $0 |
| `PutMetricData` | one call a minute from the relay, a few hundred from the runner | under $0.01 |
| Dashboard reads | `GetMetricData` for the owner's own dashboard is not charged | $0 |
| Cross-account sharing | no charge | $0 |
| PNG snapshots | `GetMetricWidgetImage` is charged; about 35 widgets and a few hundred metric requests | under $0.01 |
| Logs Insights | none on the dashboard: a log widget bills per gigabyte scanned on every refresh, so no widget uses one | $0 |
| Total | | under $0.50 |

Idle: a kept dashboard is about $3 a month. Series that receive nothing cost
nothing, the sink and links are free, and the Contributor Insights rules are the
cell's own and unchanged. A removed dashboard costs nothing. The fixtures cost
nothing idle.

Sources for the pricing basis:
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) (custom metrics
prorated by the hour and charged only in hours they are sent; dashboards prorated;
cross-account observability free). Content from that page was paraphrased.

## 11. Account changes, the account check and permissions

### The cell account's change

The account owner's stack `CellAccountBaseStack` (`stress/application/cell-account.cdk.ts`)
already takes the platform account id and adds the ingress reader role. The link
follows that pattern: a prop for the sink's ARN adds one observability link to the
account base, with the label `$AccountName` and the metric filter limited to the
namespaces `AWS/Lambda`, `AWS/ApiGateway` and `StressCell`, and shares no log group.
The sink policy in the platform account names the cell account ids and allows
only the metric resource type, so no third account can link.

A cell build cannot change the link: the cell execution policy grants
`apigateway`, `application-autoscaling`, `bedrock-agentcore`, `cloudwatch`,
`dynamodb`, `kms`, `lambda`, `logs` and `ssm` actions and no `oam` action
(`stress/application/cell-policies.ts`). A cell build can still publish its own
numbers into `StressCell` (`cloudwatch:*`), which is why the dashboard decides
nothing.

The account check of spec §3.7 refuses a stack of an unknown kind and any role it
does not expect. The link is a resource in an owner stack on the list, so it should
pass; whether creating a link also creates a service-linked role that the check
sees is unproven. Spike S-1 runs the check with the link in place.

### Reader permissions (platform account only)

A person who watches needs no access to a cell account.

| Need | Actions |
|---|---|
| Open the dashboard and read its metrics | `cloudwatch:GetDashboard`, `cloudwatch:ListDashboards`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`, `cloudwatch:GetMetricWidgetImage` |
| See cell metrics through the link, in the console | `oam:ListSinks`, `oam:ListAttachedLinks` |
| D7, the Contributor Insights widget | `cloudwatch:GetInsightRuleReport` |

The AWS managed `CloudWatchReadOnlyAccess` policy is expected to hold these; check
the policy before relying on it.

### Deployer permissions (the runner, platform account)

| Need | Actions |
|---|---|
| The dashboard stack | the CDK's bootstrap roles the account already has, `cloudwatch:PutDashboard`, `cloudwatch:DeleteDashboards` and `cloudwatch:GetDashboard` on the dashboard `<prefix>-run` |
| Metrics from the runner | `cloudwatch:PutMetricData`, limited by `cloudwatch:namespace` to `StressRun` |
| The snapshots | `cloudwatch:GetMetricWidgetImage` |

## 12. Work items

Contracts first (spec §9): items that share the `StressRun` contract of §3.1 can
build in parallel once this document and ADR-0022 are accepted. "Ready" means it
has a spec (this document), explicit input and output contracts, and no open
dependency on sibling work in flight.

| ID | Item | Where | Contract | State |
|---|---|---|---|---|
| W-12a | Emitter and runner publishing: `ScenarioActive`, `LifecycleSeconds`, record totals, `QuotaPlannedDraw`, `QuotaLimit`; the dimension allowlist; `run.sh emit` for slices | `stress/src/` | §3.1 table. Input: records, budget sums, limits file. Output: `PutMetricData` calls. Test: allowlist refuses any other dimension | ready |
| W-12b | The dashboard CDK app: one stack, one dashboard, widgets A to E as data | `stress/dashboard/` (its own app, like the driver, stress ADR-0009) | Input: run id, tier, commits, cell account ids, prefix, the plan's slices and scenarios, the Region. Output: one dashboard `<prefix>-run`. Test: synth has no resource but the dashboard, and every `StressRun` series is named, none searched | ready (the metric contract is fixed here); widgets marked unproven wait for S-3 |
| W-12c | Host relay and the k6 library's minute line | `stress/driver/`, `stress/k6/` | Input: k6's output file. Output: `Requests`, `Isolation*`, `Refusals*`, `ClientLatencyMs`. Test: a recorded output file in, the expected calls out | ready; needs spike S-2 for the lag |
| W-12d | Cell metric filters | `stress/application/cell-app.ts` | §3.2 table. Test: synth holds the filters and none with a tenant dimension | ready |
| W-12e | Sink fixture, the link in `CellAccountBaseStack`, and the deploy scripts | `stress/application/`, `stress/dashboard/` | sink ARN in, link out; the sink policy names the cell account ids | blocked: the maintainer's decision on ADR-0022, the cell owners' step, and spike S-1 |
| W-12f | Slice emitters: control-plane `BuildsInFlight`, `OnboardReadySeconds` and the PS-5 times; the runtime-isolation `collect-platform.sh` final unattributed figure through the runner | `samples/control-plane/scripts/stress/`, `samples/agentic-runtime-isolation/scripts/stress/` | `run.sh emit <metric> <value> [dim=value]` from W-12a | one task for each sample, ready after W-12a's CLI is merged |
| W-12g | Snapshots, the results file's "Dashboard window" line, `cost.sh` for the platform run, the leftover check | `stress/src/`, runtime-isolation `cost.sh` | §8, §9 | ready after W-12a and W-12b |
| W-12h | Host role statement for `PutMetricData` | `stress/driver/stress-driver.cdk.ts` | one statement, namespace-conditioned | ready |
| S-1 | Spike: link and sink between two test accounts; a dashboard widget reads a cell metric by account id; run the account check with the link | a non-production test setup | pass if the widget shows data and the check passes | open; blocks W-12e |
| S-2 | Spike: relay lag and k6 output buffering at the `small` rate | driver host | pass if a minute's counts reach CloudWatch within 3 minutes of the minute's end | open |
| S-3 | Spike: check each unproven metric of §3.3 and §6 exists as assumed; time the dashboard deploy and destroy | platform account | list of present and absent metrics; two timings | open |

## 13. Open questions for the maintainer

| # | Question | Recommendation |
|---|---|---|
| 1 | Is one link in every cell account's account base acceptable, given the spec's rule that a cell account holds four kinds of stack? | Yes: it sits in an owner stack, like the ingress reader role. Run S-1 first |
| 2 | Keep the dashboard after a run by default? | No: remove at teardown, keep the PNGs, redeploy by run id. `--keep-dashboard` for a day's work |
| 3 | May the driver host role publish `PutMetricData` into the `StressRun` namespace? | Yes: one statement, limited by namespace |
| 4 | Is a cell-published `StressCell` namespace, which a cell build could forge, acceptable for a view that decides nothing? | Yes, for a view; no for any pass criterion |

## 14. What is unproven

| Claim | Why unproven | Settled by |
|---|---|---|
| The sink and link give a dashboard in the platform account the cell account's `AWS/Lambda` and `StressCell` metrics by account id | no link exists in any cell account | S-1 |
| The account check of spec §3.7 passes with the link in the account base | not run | S-1 |
| Metric names and dimensions for CodeBuild, Step Functions, Cognito, AgentCore, and CloudFront on the front door's multi-tenant distribution | no slice reads them; named from service documentation, not from this repository | S-3 |
| The Contributor Insights widget D7 works from the platform account | not run | S-1 or S-3 |
| A metric filter can publish `$.totalMs` as a value whose p95 and p99 CloudWatch computes | standard feature, not run here | S-3 |
| A dashboard `RunId` variable can switch a dimension | not run | S-3 |
| The live view trails a run by under 3 minutes | not measured | S-2 |
| Named series of a new run show in a widget at once, without waiting for `ListMetrics` | the API reference says a new metric can take 15 minutes to be listed; named series are not listed first, but this was not tried | S-2 |
| `GetMetricWidgetImage` renders cross-account widgets | not run | S-3 |
| Deploy and destroy under a minute, and a run under $0.50 | estimates | S-3 and the first run |
| The k6 library can flush a per-minute histogram line without changing k6's request pacing | the existing ledger flushes the same way; the histogram is new | W-12c |
| `medium` and `large` | more cells need Q-7 (spec §10); the link and sink are per Region and per account, so a second cell account is one more link | after Q-7 |

Nothing in this design has run. The dashboard, the emitters, the link and the
relay are not built.
