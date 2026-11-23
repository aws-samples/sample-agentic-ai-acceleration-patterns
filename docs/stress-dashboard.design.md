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
holds only the four kinds of stack of spec §3.7. "Near-live" means that a
minute of load shows on the dashboard about three minutes after the minute ends
(§5); it is not measured yet. Spike ids `SD-1` to `SD-3` are in §12.

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
| 1 | Each minute of a k6 scenario (PS-2, PS-3, PS-4, PS-6, PS-8) shows its request counts, refusals by reason, isolation mismatches (expected 0), latency and quota headroom within about three minutes of the minute's end | a `small` run, watched while it runs (unproven, §14, spike SD-2) |
| 2 | After the run, a person sees the same run again, from the metrics, with no run-time state | redeploy by run id within 14 days, and the PNG snapshots in the run folder (§9) |
| 3 | No metric carries a tenant, user, agent or token as a dimension | a unit test of the emitter's dimension allowlist, and one of the cell app's filters (§3) |
| 4 | A cell account gains one link and no other stack kind | the account check of spec §3.7 passes with the link (unproven) |
| 5 | After teardown the run leaves nothing a person must delete: no stack, log group, role or alarm | a new leftover check in the runner's dashboard step, like the driver's `teardown.sh` check (§8, work item W-12g) |
| 6 | A run adds under $0.50 for the dashboard and its metrics, and an idle dashboard costs under $3 a month | the series counts of §10 times the list price. The Cost Explorer line (`cost.sh`) is a sanity check only: it settles a day later and mixes in the account's other CloudWatch use |
| 7 | Deploy and destroy of the dashboard are timed and reported next to the slices' (spec P-6) | a result field of the runner (§8, W-12a) |

### Risks

| Risk | What it would do | Where it is handled |
|---|---|---|
| The link breaks the account check of spec §3.7, or the cell owner cannot create it | the cell side of the dashboard stays empty | spike SD-1 (§12); fallback is the republish option (ADR option 4) |
| A cell build publishes false numbers into `StressCell` | the dashboard shows a clean run that was not | the dashboard never decides pass or fail; the record stays the record (§1) |
| The driver and the dashboard disagree | a person trusts the wrong one | the reconciliation widget D6 sets driver count against cell count (§4) |
| k6's output lines arrive late or not at all | the live view lags or goes blank | the record still holds the run; the relay's lag is measured in spike SD-2 |
| Metric names this repository has never read do not exist as assumed (CodeBuild, Cognito, AgentCore, CloudFront on a multi-tenant distribution) | a widget stays empty | §14 lists them; spike SD-3 checks each before a widget is built |
| A scenario is shorter than the live view's lag (1 minute at `small`, 5 seconds for the PS-3 herd) | the live view of that scenario arrives after it ended, and a 60-second period shows the herd as one point | the dashboard is then an after-the-scenario view at `small`; high-resolution publishing for PS-3 is not designed (§5) |

### The question the reader did not ask

*Can the dashboard be wrong, and which wins when it disagrees with the
record?*

Yes, and the record wins. The isolation count and the refusal counts the
dashboard shows come from the same driver that makes the record's counts (§5).
In platform mode the record's `unattributed` figure is the same arithmetic as the
dashboard's live gap, the driver's refusals seen minus the lines that name a
tenant and a reason (`collect-platform.sh`; the edge's and the cells' logs are
not joined, `stress/README.md`). So the dashboard cannot catch a driver bug.
What can is a second view of the request count from the cell's own logs (widget
D6). A person reads the dashboard to steer a run, and reads the results file to
judge it.

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
| Control plane, registrar, identity API, route table | platform | run's Region (the identity API's Region can differ, `STRESS_FD_IDENTITY_REGION`; C3 then sets its own `region`) | native metrics, searched by name (§3.3) | nothing to set up | none |
| Router and distribution | platform | `us-east-1` | native metrics, a widget with `region` set, searched by name | nothing to set up | none |
| Ingress, authoriser, API Gateway status, Lambda, AgentCore Runtime, SDK retries | each cell account | run's Region | the sink and one link per cell account | the account owner, once (§11) | none |

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
| `IsolationAssertions`, `IsolationMismatches` | Count | `RunId`, `Slice`, `Scenario` | host relay, per minute, for k6 scenarios only |
| `IsolationAssertionsFinal`, `IsolationMismatchesFinal` | Count | `RunId`, `Slice`, `Scenario` | runner, once per scenario record when `run` returns, stamped at the minute the scenario's window ends; every slice, k6 or not, no slice code |
| `Requests` | Count | `RunId`, `Scenario`, `StatusClass` | host relay |
| `RefusalsSeen`, `RefusalsNamed` | Count | `RunId`, `Scenario` | host relay: every 4xx or 5xx the driver counted, and those whose line names a tenant and a reason |
| `RefusalsByReason` | Count | `RunId`, `Scenario`, `Reason` | host relay |
| `RefusalsUnattributed` | Count | `RunId`, `Slice`, `Scenario` | runner, once per record after the slice's `collect` (spec P-7), stamped like the final isolation counts |
| `ClientLatencyMs` | Milliseconds | `RunId`, `Scenario` | host relay, as a histogram (`Values` and `Counts`): at most 150 buckets a datum, so the percentiles are bucket-resolution, not the exact figures of the record |
| `OnboardReadySeconds` | Seconds | `RunId` | control-plane driver: one value per tenant (PS-1, spec §5.1) |
| `BuildsInFlight` | Count | `RunId` | control-plane driver: the builds it has started and not seen end, every 15 s (it already paces waves at the build limit, stress ADR-0013) |
| `RoutableSeconds`, `SuspendedSeconds`, `RemovedSeconds` | Seconds | `RunId` | control-plane driver (PS-5): one value per churn tenant |
| `LifecycleSeconds` | Seconds | `RunId`, `Slice`, `Phase` | runner: after each slice's `deploy`, `teardown` and platform step, and for the dashboard stack itself under slice `dashboard` |
| `QuotaPlannedDraw`, `QuotaLimit` | Count | `RunId`, `Account`, `Quota` | runner: from the budget's sums and the `--limits` file, at the start and every 60 s |

Two CloudWatch rules shape how the dashboard names these series
([metrics concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html),
[`PutMetricData`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricData.html)):

- CloudWatch does not aggregate across the dimensions of a custom metric. A
  total over all scenarios needs either a metric math sum of the named series or
  a series published without the dimension. So the dashboard stack takes the
  run's plan (the slices and scenarios the runner has already resolved) and names
  every series it draws, and the cell filters publish a total with no dimension
  beside each breakdown. A series that gets no data point in a minute leaves a
  gap, so math that subtracts two series wraps each in `FILL(m, 0)`.
- A new metric can take up to 15 minutes to appear in `ListMetrics`, which
  `SEARCH` expressions use, and a metric with no data for two weeks is not listed
  at all. A widget on a series that is new in this run (every `StressRun` series,
  because `RunId` is new) names its metrics explicitly and does not search.

The runner writes a record's totals when `run` returns, so its timestamps are
minutes old. A data point three to 24 hours old can take up to two hours to
become readable, and one older than a day at least 48 hours, so the runner does not
backfill a finished run.

### 3.2 `StressCell`, published in each cell account

Metric filters on the cell's own structured log lines (the field names are the
ones `collect.sh` queries today). The stress cell app adds them, which is new
code in `stress/application/cell-app.ts`: it can reach the three log groups
through the stack's ingress construct the way the sample's own Contributor
Insights rules do (`demo.cdk.ts`, `findChild('ApiAccessLogs')` and
`findChild('IngressLogs')`; the authoriser's group is the construct
`AuthorizerLogs`, `shared-ingress.cdk.ts`). The runtime-isolation sample does not
change. The stress cell is on the `api-gateway` ingress, which is the one that has
the access log and the four Contributor Insights rules. A metric filter takes up
to three dimensions from JSON fields, so it publishes a tenant dimension only if
its author writes one; the cell app's unit test asserts none does.

| Metric | Unit | Dimension | Log group, filter, value |
|---|---|---|---|
| `IngressRequests` | Count | `Status` (`$.status`), and a total with none | API access log, every line, value 1 |
| `IngressServedMs`, `IngressTtfbMs` | Milliseconds | none | ingress log, `request served`, value `$.totalMs` and `$.ttfbMs` |
| `IngressRefused` | Count | `Reason`, `Status`, and a total with none | ingress log, `request refused`, value 1 |
| `AuthorizerRefused` | Count | `Reason`, and a total with none | authoriser log, `request refused`, value 1. The authoriser's line carries no `status`, and a filter with a dimension publishes nothing for a line that lacks the field |
| `AuthorizerTokenRefused` | Count | none | authoriser log, `token refused`, value 1 |
| `SdkRetryLines` | Count | `Service` (`$.service`), and a total with none | `sdk retried` lines of the ingress log and of the authoriser log, both into the same metric, value 1 |
| `MintLookups` | Count | `Mint` (`$.mint`) | ingress log, `request served`, value 1 |

The dashboard names the `Status`, `Reason`, `Service` and `Mint` values it
draws (the statuses the ingress returns, the refusal reasons and `mint` values
that the sample's code logs, and the SDK services `sts`, `kms` and `dynamodb`).
A value outside the list shows in the total and not in the breakdown.

`SdkRetryLines` counts the calls that the SDK retried, not the retries
(`attempts - 1` in the log line, which a filter cannot compute). It is a
signal that a quota is near, not a measure of it. The authoriser signs with KMS
(its role is the one allowed `kms:Sign`), so the KMS retries may be logged in the
authoriser's group and not the ingress's; the filter reads both, and whether the
authoriser logs `sdk retried` at all is unproven (§14).

### 3.3 Native metrics

| Source | Namespace and metrics | Read today by |
|---|---|---|
| Router | `AWS/CloudFront`: `FunctionComputeUtilization`, `FunctionInvocations`, `FunctionExecutionErrors`, `FunctionThrottles`, `FunctionValidationErrors`; dimensions `FunctionName`, `Region=Global`; in `us-east-1` | front-door slice `collect` (`test/stress/collect.ts`) |
| Account Lambda | `AWS/Lambda` with no dimension: `ConcurrentExecutions`, `Throttles`, `Errors`, `Invocations` | runtime-isolation `collect.sh` (`account-concurrency`) |
| Identity API | `AWS/ApiGateway`: `Count`, `4XXError`, `5XXError`; dimension `ApiName` | tenant-identity driver (`apiSum`) |
| Route table | `TenantFrontDoor`: `RouteTableBytes`; dimension `DistributionId` | the front door's own alarm (80 % of the 5 MB store) |
| Control plane builds | `AWS/CodeBuild`: `Builds`, `FailedBuilds`, `Duration`, `QueuedDuration`; dimension `ProjectName` | no slice reads these today |
| Control plane workflow | `AWS/States`: `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionThrottled` | no slice reads these today |
| Distribution | `AWS/CloudFront`: `Requests`, `4xxErrorRate`, `5xxErrorRate`; dimensions `DistributionId`, `Region=Global` | no slice reads these today |
| AgentCore Runtime, in each cell account | `AWS/Bedrock-AgentCore`: `Throttles`, aggregated `Invocations`, aggregated sessions, `ActiveSessionCount`, per the [AgentCore runtime metrics list](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-runtime-metrics.html); exact metric and dimension names to check | no slice reads these today |

Rows that "no slice reads today" are unproven (§14). The dashboard is deployed
before the slices, so it cannot name the router, the distribution, the CodeBuild
projects, the state machine or the identity API, which the slices create after
it. Those widgets search by name in the run's own account. A search finds a
metric only 15 minutes after its first data point at the latest, and not at all
after two weeks without data (§3.1), so these widgets can lag at the start of
PS-1 and are blank for a run redeployed more than 14 days later (§9).

## 4. Widget list

Every widget has a metric, a namespace, dimensions, a statistic, a period and the
scenarios it serves. Periods are 60 s except where stated. "Near-live" is the lag
of §5; "after" means at the end of the scenario or the run. Scenario ids are those of
spec §5. Slice scenarios: runtime-isolation S1 to S7, control-plane placement
races, read rate and build-limit scaling, tenant-identity token issue and
`CreateTenant` under throttling, front-door route-write, router-load and
edge-refusals. The k6 scenarios are PS-2, PS-3, PS-4, PS-6, PS-8 and the runtime-isolation
S1 to S7; PS-1, PS-5 and PS-7 are driven by TypeScript or shell drivers and feed
only the runner's own series.

### A. The run (platform account, `StressRun`)

| ID | Widget | Metric (namespace `StressRun`) | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| A1 | Run header: run id, tier, commits (text), and the scenario strip. The only widget that shows scenario windows (§9) | `ScenarioActive` | `RunId`, `Scenario` | Maximum | every scenario | near-live |
| A2 | Isolation: a graph of assertions and mismatches per minute with a line at 0, and a number for the run's total mismatches from the final series | live: `IsolationAssertions`, `IsolationMismatches`; number: `IsolationAssertionsFinal`, `IsolationMismatchesFinal` | `RunId`, `Slice`, `Scenario` | Sum | graph: PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7; number: every scenario | graph near-live, number after each scenario |
| A3 | Refusals: seen against named, and their gap; the record's unattributed count as a number | `RefusalsSeen`, `RefusalsNamed`, math `FILL(seen, 0) - FILL(named, 0)`; `RefusalsUnattributed` | `RunId`, `Scenario`, and `Slice` for the number | Sum | PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7 | gap near-live, number after each scenario |
| A4 | Requests by status class | `Requests` | `RunId`, `Scenario`, `StatusClass` | Sum | PS-2, PS-3, PS-4, PS-6, PS-8 | near-live |
| A5 | Refusals by reason | `RefusalsByReason` | `RunId`, `Scenario`, `Reason` | Sum | PS-2, PS-3, PS-4, PS-6, PS-8; most use in PS-4 (noisy neighbour) and PS-3 (herd) | near-live |
| A6 | Client latency p50, p95, p99 (bucketed, so approximate) | `ClientLatencyMs` | `RunId`, `Scenario` | p50, p95, p99 | PS-2, PS-3, PS-4, PS-6, PS-8 | near-live |
| A7 | Onboarding: ready time p50 and p95, and builds in flight against the build limit | `OnboardReadySeconds`, `BuildsInFlight` | `RunId` | p50, p95; Maximum | PS-1, control-plane build-limit scaling | as they finish (ready time), 15 s (builds) |
| A8 | Churn: time to routable, to suspended, to removed | `RoutableSeconds`, `SuspendedSeconds`, `RemovedSeconds` | `RunId` | p50, p99 | PS-5, front-door route-write | as each churn tenant finishes |
| A9 | Deploy and destroy seconds per slice and for the dashboard (table) | `LifecycleSeconds` | `RunId`, `Slice`, `Phase` | Maximum | P-6, every run | after each verb |

### B. The edge (platform account, `us-east-1`)

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| B1 | Router compute utilisation (percent), with a line at 100 | `AWS/CloudFront` `FunctionComputeUtilization` | `FunctionName`, `Region=Global` | Maximum | every scenario through the edge, PS-1 to PS-8, and router-load. The front-door slice measured 94 % in a minute at `small` | native, 1 point a minute |
| B2 | Router errors and throttles | `FunctionExecutionErrors`, `FunctionThrottles`, `FunctionValidationErrors`, and `FunctionInvocations` for scale | same | Sum | PS-1 to PS-8, edge-refusals | native |
| B3 | Distribution requests and error rates | `AWS/CloudFront` `Requests`, `4xxErrorRate`, `5xxErrorRate` | `DistributionId`, `Region=Global` | Sum; Average | PS-1 to PS-8 | native (unproven for this distribution type) |
| B4 | Route table bytes against the store's cap (80 % line) | `TenantFrontDoor` `RouteTableBytes`, in the run's Region | `DistributionId` | Maximum, 300 s | PS-1, PS-5 at `large` (4,000 routes) | native |

B1 to B3 find the router and the distribution by search in `us-east-1`, because
the dashboard is deployed before the front door (§3.3). Only one front door can
exist in a Region of an account, because it publishes a parameter with a fixed
name (`samples/tenant-front-door/scripts/stress/README.md`, Known limitations), so
the search finds one router.

### C. The platform account

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| C1 | Builds: started, failed, queued time, duration | `AWS/CodeBuild` `Builds`, `FailedBuilds`, `QueuedDuration`, `Duration` | `ProjectName`, by search on the fleet prefix | Sum; Average | PS-1, PS-5, control-plane scenarios | native (unproven) |
| C2 | Control-plane workflow executions | `AWS/States` `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionThrottled` | `StateMachineArn`, by search on the fleet prefix | Sum | PS-1, PS-5, control-plane scenarios | native (unproven) |
| C3 | Identity API: calls and errors | `AWS/ApiGateway` `Count`, `4XXError`, `5XXError` | `ApiName`, by search; its own `region` when the identity is in another Region | Sum | PS-1 (identity calls), identity scenarios | native |
| C4 | Lambda account-wide: concurrency, throttles, errors | `AWS/Lambda` `ConcurrentExecutions` (Maximum), `Throttles`, `Errors` (Sum) | none | as listed | PS-1, PS-5, route-write | native |

### D. The cell accounts (one set per cell account, through the link)

| ID | Widget | Metric | Dimensions | Statistic | Serves | When |
|---|---|---|---|---|---|---|
| D1 | Ingress requests by status | `StressCell` `IngressRequests` | `Status`; total with none | Sum | PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7 | near-live |
| D2 | Ingress latency p50, p95, p99 and TTFB | `StressCell` `IngressServedMs`, `IngressTtfbMs` | none | p50, p95, p99 | PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7 | near-live |
| D3 | Refusals by reason, ingress and authoriser, and token refusals | `StressCell` `IngressRefused`, `AuthorizerRefused`, `AuthorizerTokenRefused` | `Reason`, `Status` (ingress only); totals with none | Sum | PS-2, PS-3, PS-4, PS-6, PS-8, S1 to S7; most use in PS-3, PS-4, PS-8 | near-live |
| D4 | Lambda in the cell account: concurrency, throttles, errors | `AWS/Lambda` `ConcurrentExecutions` (Maximum), `Throttles`, `Errors` | none | as listed | PS-2, PS-3, PS-4, PS-6, PS-8; most use in PS-3 (herd) and PS-8 (peak) | native |
| D5 | SDK retried calls by service, and mint lookups | `StressCell` `SdkRetryLines` by `Service`; `MintLookups` by `Mint` | `Service`; `Mint` | Sum | PS-2, PS-3, PS-4, PS-6, PS-8; most use in PS-3 (STS, KMS) and PS-8 | near-live |
| D6 | Reconciliation: the driver's 2xx against the cell's 200, and the gap | `StressRun` `Requests` (`2xx`) against `StressCell` `IngressRequests` (`Status` 200), math `FILL(driver, 0) - FILL(cell, 0)` | as above | Sum | PS-2, PS-3, PS-4, PS-6, PS-8 | near-live |
| D7 | Top tenants by requests, errors, backend seconds, output tokens | the cell's four Contributor Insights rules (runtime-isolation ADR-0021) | rule | Sum | PS-4 (the noisy tenant), PS-8 | near-live (cross-account support unproven) |
| D8 | AgentCore Runtime: throttles, invocations, new sessions, active sessions | `AWS/Bedrock-AgentCore` `Throttles`, aggregated invocations and sessions, `ActiveSessionCount` | names to check | Sum; Maximum | PS-2, PS-3, PS-4, PS-6, PS-8; most use in PS-3 and PS-8 | native (unproven) |

D6 is the widget that can show the driver wrong. A persistent gap that the edge's
refusals (B2) do not explain is a finding. In the k6 scenarios every agent call
that the edge accepts reaches the one cell's ingress at `small` (stress
ADR-0016). At `medium` and `large` D6 waits for Q-7.

### E. Quota headroom (§6)

| ID | Widget | Metric | Serves | When |
|---|---|---|---|---|
| E1 | One panel per budgeted quota with a signal: planned draw, limit and the observed peak (§6) | `StressRun` `QuotaPlannedDraw`, `QuotaLimit`; the signal named in §6 | PS-1 (builds, Cognito), PS-3 and PS-8 (Lambda, STS, KMS, AgentCore) | near-live |
| E2 | The first quota to give out: a table of quota, account, peak as a percent of the limit, sorted | math over E1 | PS-8 (spec §5.1 "the first quota that gives out") | after |

The free allowance is three dashboards of up to 50 metrics each. This
dashboard names more than 50 series, because every `StressRun` metric is named
once for each scenario of the plan and the cell widgets repeat for each cell
account, so it is billed (§10).

### Where each scenario is watched

Built from the Serves columns above; where the two disagree, the Serves column
wins.

| Scenario | Widgets |
|---|---|
| PS-1 onboarding | A1, A2 (number), A7, A9, B1 to B4, C1 to C4, E1 |
| PS-2 steady | A1 to A6, B1 to B3, D1 to D6, D8 |
| PS-3 herd | A1 to A6, B1 to B3, D1 to D6, D8, E1 |
| PS-4 noisy neighbour | A1 to A6, B1 to B3, D1 to D8 |
| PS-5 churn | A1, A2 (number), A8, A9, B1 to B4, C1, C2, C4 |
| PS-6 long streams | A1 to A6, B1 to B3, D1 to D6, D8 |
| PS-7 cross-cell probes | A1, A2 (number), B1 to B3 |
| PS-8 peak | A1 to A6, B1 to B3, D1 to D8, E1, E2 |
| Slice scenarios | the widgets of the platform scenario of the same shape; runtime-isolation S1 to S7 use A1 to A6 and D1 to D3 |

## 5. Isolation mismatches and unattributed refusals

The two counts are the test's pass criteria (spec §7). They reach CloudWatch by
two paths, a near-live one for k6 scenarios and a per-record one for every
scenario. The two paths write different metric names, so no count is published
twice.

| Count | Near-live path (k6 scenarios) | Per-record path (every scenario) |
|---|---|---|
| Isolation assertions and mismatches | k6's own lines. The k6 library keeps one counter per assertion and prints a line per mismatch (`isolation_mismatch`, `stress/k6/lib.js`). A relay on the driver host reads k6's output file, sums by minute, and calls `PutMetricData` (`IsolationAssertions`, `IsolationMismatches`). | The runner reads each record when `run` returns and publishes its `isolation` totals as `IsolationAssertionsFinal` and `IsolationMismatchesFinal`, stamped at the end of the scenario's window. This covers PS-1, PS-5 and PS-7 as well, with no slice code. |
| Refusals seen, named and unattributed | The k6 library counts every 4xx and 5xx (`refusals_seen`) and prints a `body_refusal` line for a refusal inside a 200; the runtime-isolation sample's `scripts/stress/k6/edge-refusals.js` prints an `edge_refusal` line for each refusal the edge or a cell answers. Each line names a tenant and a reason. The relay publishes `RefusalsSeen` and `RefusalsNamed`; their gap is the live estimate of the unattributed count. | The record's `refusals.unattributed`, which the runner publishes as `RefusalsUnattributed` after the slice's `collect`. |

In platform mode the record's figure and the live gap are the same arithmetic:
`collect-platform.sh` counts the driver's lines and treats the rest as
unattributed, and joins no hop log. So A3 shows one number twice, at two times.
It is not a second check. The independent check on the request count is D6. In
slice mode `collect` joins the hops' logs, and the record's figure can differ from
the live gap; the dashboard serves platform runs, so that case is not drawn.

The relay is a short script, run with `bash` (the host script `k6.sh` generates
runs under `sh`), that `stress/driver/k6.sh` starts on the host before k6 and stops
after it. It reads the file `k6.sh` already keeps (`/opt/stress/out/k6-stdout.txt`),
needs `jq` (installed on the host), and takes `Slice` and `Scenario` as two new
`NAME=value` arguments to `k6.sh`, because the host script receives neither. It
needs three changes to existing code:

1. The k6 library flushes one more line per VU per minute (the existing
   `tenant_minute` ledger flushes the same way): the count by status class, the
   assertion count, and a latency histogram. The histogram has fixed
   log-spaced buckets, at most 150 and about 12 % wide from 1 ms to 120 s, so a
   percentile is right to the bucket. The relay sums the lines of all VUs for a
   minute and publishes the minute once every VU has passed it, or after a grace
   of 90 s.
2. The runtime-isolation sample's `edge-refusals.js` is not changed; the relay
   reads its lines as they are.
3. The driver host role gains `cloudwatch:PutMetricData`, limited by the condition
   key `cloudwatch:namespace` to `StressRun`. The action has no resource type, so
   the statement's resource is `*`, as for the Run Command actions (stress
   ADR-0009).

The lag has three parts: the minute itself, up to 90 s of grace for slow VUs, and
CloudWatch's own delay. A minute of load therefore shows about three minutes after
it ends, if the delay is under a minute. That is unmeasured; spike SD-2 measures
it. Two consequences for the tiers. A `small` scenario is one minute long
(spec §4.1), so its counts show after it ended: at `small` the dashboard is a
view of the last scenario while the next one runs, not of the one running. From
`medium` (3-minute scenarios) part of a scenario shows while it runs. And the PS-3
herd is a 5-second shape (spec §5.1): every live widget has a 60-second period, so
the herd is one point. A high-resolution series (1 to 5 seconds, kept 3 hours)
would show it, and it is not designed here; the record and `collect` keep the
herd's detail.

What the dashboard cannot show: edge overhead as the spec defines it (client
time to first byte minus ingress time to first byte, joined per request on the
correlation id, spec §6). A6 and D2 show the two sides as separate
percentiles, which is an approximation. The per-request join stays in `collect`.

## 6. Quota headroom against the quota budget

The runner already adds each slice's `budget` per account and refuses to start
over a quota (spec §4.4, `stress/src/budget.ts`). It publishes the sums
(`QuotaPlannedDraw`) and the limits it checked against (`QuotaLimit`, from the
`--limits` file) once at the start and every 60 s, with the budget's account
labels. The dashboard draws the planned draw and the limit as lines, and the
observed peak where a signal exists. The planned draw is the budget's figure,
which for PS-4 in platform mode is the slice-mode figure, all on `cell-account-1`,
so it overstates what one cell account draws (`stress/README.md`, known
limitations).

| Quota id | Signal on the dashboard | Where | Gap |
|---|---|---|---|
| `lambda-concurrency` | `AWS/Lambda` `ConcurrentExecutions`, Maximum, no dimension | C4, D4 | none; read today |
| `codebuild-linux-small` | `BuildsInFlight` from the control-plane driver | A7 | CodeBuild publishes no concurrency metric that this design found; the driver's own count stands in (unproven) |
| `sts-assume-role-rps` | `SdkRetryLines` for `Service` `sts` | D5 | STS publishes no rate metric; the signal is that calls were retried, not the rate or the percent of 600 |
| `kms-rsa-rps`, `kms-ecc-rps` | `SdkRetryLines` for `Service` `kms` | D5 | the same: a retry signal only; which log group holds it is unproven (§3.2) |
| `agentcore-new-sessions-rps`, `agentcore-active-sessions`, `agentcore-runtime-tps` | `AWS/Bedrock-AgentCore`: aggregated sessions (new sessions a second from the sum over 60 s), `ActiveSessionCount`, `Throttles` and aggregated invocations (calls a second) | D8, E1 | the AgentCore documentation lists these metrics; exact names and dimensions are unproven (§14) |
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
that ADR, unverified; with the `Backend` dimension set a tenant costs
`9 x (1 + agents)` metrics, which at 25 agents a cell is 26 times more
(`src/shared/metrics.ts`)). The stress cell app does not set `perTenantMetrics`, and
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
It costs nothing while nothing is sent (§10). The runner has no leftover check
today; each slice's `teardown` and the driver's `teardown.sh` have their own. The
runner's new dashboard step (W-12g) adds one with three lines: the dashboard
`<prefix>-run` is gone, the stack `<prefix>-dashboard` is gone, and no metric
filter of the `StressCell` namespace remains in a cell account whose cells are
deleted.

### Deploy and destroy time

Not measured. A stack with one dashboard resource should create and delete in
well under a minute, and the sink and link in seconds. Those are expectations,
not results. The spike SD-3 deploys the dashboard stack and the link and times
each with the runner's own timer. In a run, the dashboard's two numbers go into the
results file's deploy and destroy table (spec P-6). The runner today writes a
lifecycle record for each slice and refuses a record that names a slice the run
did not run (`stress/src/runner.ts`, `stress/README.md`), so W-12a either teaches
`result.ts` and `runner.ts` a `dashboard` entry or keeps the two numbers beside
the records; it is a code change, not a free choice of name. A dashboard that
takes minutes to remove is a finding.

The dashboard is deployed before the first slice, so it never delays a slice, and
removed after the last. In a platform run it adds its two times to the run's wall
clock, which at `small` is about 90 minutes (`stress/results/2026-11-21-small.md`).

## 9. Annotations, and the view afterwards

### Annotations

| What | How |
|---|---|
| Run id, tier, commits | A text widget (A1) filled from stack parameters at deploy |
| Scenario start and end | `ScenarioActive` (A1's strip): 1 each minute while the scenario's `run` verb runs, 0 at its end, one labelled line for each scenario. The runner publishes it. The strip is in A1 only, at the top of the dashboard; a person reads every other widget against it, since all share the dashboard's time range. A band on every widget would need `ScenarioActive` added to each graph on a right axis, which is not designed |
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
   use the window. Within 14 days of the run this shows every widget. After that
   the searched widgets (B1 to B3, C1 to C3) show nothing, because a metric with
   no data for two weeks is not listed (§3.3); the PNGs are the view of such a run. If the dashboard supports a `RunId` variable on a dimension,
   one dashboard can serve any run; that is unproven, and redeploying with the id is
   the fallback.
2. Before removal, the runner saves a PNG of each widget for the run's window
   (`GetMetricWidgetImage`) into the run folder outside the repository
   (`$STRESS_HOME/<prefix>/<run id>/dashboard/`). They are not committed: D7 can
   show tenant identifiers.

Metric retention is the limit: one-minute points are kept 15 days, five-minute
points 63 days, one-hour points 15 months
([CloudWatch metrics concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html)).
A run older than 15 days is seen at five-minute resolution, which hides a
one-minute `small` scenario and the 5-second herd of PS-3 (§5). The PNGs, made
at one-minute resolution before removal, are the view of such a run.

## 10. Cost per run and idle

All figures are list-price estimates, not measurements, and prices differ by
Region. The arithmetic is series count times price times the hours in which data
is sent. The `small` run of 2026-11-21 lasted about 90 minutes; the table uses 3
hours as a ceiling. `cost.sh` (runtime-isolation; the platform run needs the same
call, W-12g) reads the day's CloudWatch line from Cost Explorer a day later, in an
account that has other CloudWatch use, so it can confirm the order of magnitude and
cannot confirm a few cents.

| Item | Basis | Per run (3 hours at most) |
|---|---|---|
| Dashboard | about $3 a dashboard-month, prorated by the hour; the first three dashboards of up to 50 metrics are free, this one has more | about $0.01 |
| `StressRun` series | about 150 series (§3.1: about 10 for each k6 scenario and about 3 for each other one, with the scenarios of the plan, and about 20 at run level) at $0.30 a series-month, charged only for the hours in which data is sent: 150 x $0.30 x 3 / 730 | about $0.18 |
| `StressCell` series | about 35 series for each cell account (§3.2: the status, reason, service and mint breakdowns with their totals), one cell account at `small` and two at `medium` and `large`: 35 x $0.30 x 3 / 730 each | about $0.04 at `small`, $0.09 at `medium` and `large` |
| Metric filters | no charge for the filter itself | $0 |
| `PutMetricData` | one call a minute from the relay, a few hundred from the runner | under $0.01 |
| Dashboard reads | `GetMetricData` for the owner's own dashboard is not charged | $0 |
| Cross-account sharing | no charge | $0 |
| PNG snapshots | `GetMetricWidgetImage` is charged; about 40 widgets and a few hundred metric requests | under $0.01 |
| Logs Insights | none on the dashboard: a log widget bills per gigabyte scanned on every refresh, so no widget uses one | $0 |
| Total | | under $0.50 |

Idle: a kept dashboard is about $3 a month. Series that receive nothing cost
nothing, the sink and links are free, and the Contributor Insights rules are the
cell's own and unchanged. A removed dashboard costs nothing. The fixtures cost
nothing idle.

Sources for the pricing basis:
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) (custom metrics
prorated by the hour and charged only in hours they are sent; dashboards prorated;
cross-account observability free).

## 11. Account changes, the account check and permissions

### The cell account's change

The account owner's stack `CellAccountBaseStack` (`stress/application/cell-account.cdk.ts`)
already takes the platform account id and adds the ingress reader role. The link
follows that pattern: a prop for the sink's ARN adds one observability link to the
account base, with the label `$AccountName` and the metric filter limited to the
namespaces `AWS/Lambda`, `AWS/Bedrock-AgentCore` and `StressCell` (the three the cell
widgets read), and shares no log group.
The sink policy in the platform account names the cell account ids and allows
only the metric resource type, so no third account can link.

A cell build cannot change the link: the cell execution policy grants
`apigateway`, `application-autoscaling`, `bedrock-agentcore`, `cloudwatch`,
`dynamodb`, `kms`, `lambda`, `logs` and `ssm` actions and no `oam` action
(`stress/application/cell-policies.ts`). A cell build can still publish its own
numbers into `StressCell` (`cloudwatch:*`), which is why the dashboard decides
nothing.

The account check of spec §3.7 refuses a stack of an unknown kind and the role
classes it lists (a `cdk-hnb659fds-*` role, a role pair half with another policy or
trust, a `/cell/` role trusted from outside). The link is a resource in an owner
stack on the list, so it should pass; whether creating a link also creates a
service-linked role that the check sees is unproven. Spike SD-1 runs the check with
the link in place.

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
| W-12a | Emitter and runner publishing: `ScenarioActive`, `LifecycleSeconds` (and the `dashboard` entry in `result.ts` and `runner.ts`, §8), the `...Final` and `RefusalsUnattributed` totals from records, `QuotaPlannedDraw`, `QuotaLimit`; the dimension allowlist; `run.sh emit` for slices; `--keep-dashboard` | `stress/src/` | §3.1 table. Input: records, budget sums, limits file. Output: `PutMetricData` calls. Test: allowlist refuses any other dimension | ready |
| W-12b | The dashboard CDK app: one stack, one dashboard, widgets A to E as data | `stress/dashboard/` (its own app, like the driver, stress ADR-0009) | Input: run id, tier, commits, cell account ids, prefix, the plan's slices and scenarios, the Region. Output: one dashboard `<prefix>-run`. Test: synth has no resource but the dashboard, and every `StressRun` series is named, none searched | ready (the metric contract is fixed here); widgets marked unproven wait for SD-3 |
| W-12c | Host relay (bash), the two new `NAME=value` arguments of `k6.sh` (`Slice`, `Scenario`), and the k6 library's minute line. The relay reads the `edge_refusal` lines of the runtime-isolation sample's `edge-refusals.js` as they are | `stress/driver/`, `stress/k6/` | Input: k6's output file. Output: `Requests`, `IsolationAssertions`, `IsolationMismatches`, `Refusals*`, `ClientLatencyMs`. Test: a recorded output file in, the expected calls out | ready; needs spike SD-2 for the lag |
| W-12d | Cell metric filters of §3.2, on the ingress, authoriser and access log groups | `stress/application/cell-app.ts` | §3.2 table. Test: synth holds the filters and none with a tenant dimension | ready |
| W-12e | Sink fixture, the link in `CellAccountBaseStack`, and the deploy scripts | `stress/application/`, `stress/dashboard/` | sink ARN in, link out; the sink policy names the cell account ids | blocked: the maintainer's decision on ADR-0022, the cell owners' step, and spike SD-1 |
| W-12f | Slice emitters in the control-plane slice: `BuildsInFlight`, `OnboardReadySeconds` and the PS-5 times. No other slice emits: the runner reads their records | `samples/control-plane/scripts/stress/` and its driver | `run.sh emit <metric> <value> [dim=value]` from W-12a | ready after W-12a's CLI is merged |
| W-12g | The runner's dashboard step: deploy and remove the stack, the snapshots, the results file's "Dashboard window" line, the new leftover check (§8), and `cost.sh` for the platform run | `stress/src/`, runtime-isolation `cost.sh` | §8, §9, §10 | ready after W-12a and W-12b |
| W-12h | Host role statement for `PutMetricData` | `stress/driver/stress-driver.cdk.ts` | one statement, namespace-conditioned | ready |
| SD-1 | Spike: link and sink between two test accounts; a dashboard widget reads a cell metric by account id; run the account check with the link | a non-production test setup | pass if the widget shows data and the check passes | open; blocks W-12e |
| SD-2 | Spike: relay lag and k6 output buffering at the `small` rate; whether a named series of a new run shows at once | driver host | pass if a minute's counts reach CloudWatch within 3 minutes of the minute's end | open |
| SD-3 | Spike: check each unproven metric of §3.3 and §6 exists as assumed; time the dashboard deploy and destroy | platform account | list of present and absent metrics; two timings | open |

The spike ids differ from the spec's `S1` to `S7` (runtime-isolation scenarios) and the
front door's spikes `S-2`, `S-3`, `S-5` and `S-7`.

## 13. Open questions for the maintainer

| # | Question | Recommendation |
|---|---|---|
| 1 | Is one link in every cell account's account base acceptable, given the spec's rule that a cell account holds four kinds of stack? | Yes: it sits in an owner stack, like the ingress reader role. Run SD-1 first |
| 2 | Keep the dashboard after a run by default? | No: remove at teardown, keep the PNGs, redeploy by run id. `--keep-dashboard` for a day's work |
| 3 | May the driver host role publish `PutMetricData` into the `StressRun` namespace? | Yes: one statement, limited by namespace |
| 4 | Is a cell-published `StressCell` namespace, which a cell build could forge, acceptable for a view that decides nothing? | Yes, for a view; no for any pass criterion |

## 14. What is unproven

| Claim | Why unproven | Settled by |
|---|---|---|
| The sink and link give a dashboard in the platform account the cell account's `AWS/Lambda`, `AWS/Bedrock-AgentCore` and `StressCell` metrics by account id | no link exists in any cell account | SD-1 |
| The account check of spec §3.7 passes with the link in the account base | not run | SD-1 |
| Metric names and dimensions for CodeBuild, Step Functions, Cognito, AgentCore and CloudFront on the front door's multi-tenant distribution | no slice reads them; named from service documentation, not from this repository | SD-3 |
| The authoriser logs `sdk retried` lines, so the KMS retry signal exists in the authoriser's log group | the ingress's group is the one `collect.sh` reads; the authoriser's role holds `kms:Sign` | SD-3 |
| The Contributor Insights widget D7 works from the platform account | not run | SD-1 or SD-3 |
| A metric filter can publish `$.totalMs` as a value whose p95 and p99 CloudWatch computes | standard feature, not run here | SD-3 |
| A dashboard `RunId` variable can switch a dimension | not run | SD-3 |
| The live view trails a minute of load by under 3 minutes, and a 60-second period shows a 5-second herd as one point | not measured; the period is CloudWatch's standard resolution | SD-2 |
| Searched widgets (B1 to B3, C1 to C3) show data from the first minute of PS-1 | a new metric can take up to 15 minutes to be listed | SD-2 |
| `GetMetricWidgetImage` renders cross-account widgets | not run | SD-3 |
| Deploy and destroy under a minute, and a run under $0.50 | estimates | SD-3 and the first run |
| The k6 library can flush a per-minute histogram line without changing k6's request pacing | the existing ledger flushes the same way; the histogram is new | W-12c |
| `medium` and `large` | more cells need Q-7 (spec §10); the link and sink are per Region and per account, so a second cell account is one more link | after Q-7 |

Nothing in this design has run. The dashboard, the emitters, the link and the
relay are not built.
