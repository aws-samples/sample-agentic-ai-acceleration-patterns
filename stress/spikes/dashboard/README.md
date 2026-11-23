<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# Spikes SD-1, SD-2 and SD-3: the run dashboard

The three spikes of [`docs/stress-dashboard.design.md`](../../../docs/stress-dashboard.design.md) §12 settle
what the design could not prove (stress ADR-0022). They ran on 2026-11-23 against a non-production platform
account and a non-production cell account, with synthetic data only. This folder holds the templates and
scripts; the results are below. Each one that failed to match the design is named as such.

| File | What it is |
|---|---|
| [`sink.yaml`](./sink.yaml), [`link.yaml`](./link.yaml), [`sd1.sh`](./sd1.sh) | SD-1 and SD-3: a sink in the platform account; a link, metric filters and a function in the cell account; `up`, `drive`, `read`, `down` |
| [`dash.yaml`](./dash.yaml), [`sd3-dashboard.sh`](./sd3-dashboard.sh) | SD-3: a stack with one dashboard, with a `RunId` variable, timed |
| [`relay-load.js`](./relay-load.js) | SD-2: the load of a platform scenario with no HTTP in it, run on the driver host through `driver/k6.sh` |

Run `sd1.sh` as `PLATFORM_PROFILE=<profile> CELL_PROFILE=<profile> CELL_ACCOUNT=<12 digits> AWS_REGION=<Region> ./sd1.sh up|drive|read|down`.
It deploys named stacks (`StressDashSpike*`) and `down` removes them, the link before the sink.

## SD-1: the link and the sink

**Result: passed.** A dashboard in the platform account reads a cell account's metrics by account id, and the
account check of spec §3.7 accepts the link.

| Check | Result |
|---|---|
| Deploy the sink (platform account) and the link (cell account) | 36 s and 37 s; 37 s and 36 s in a second Region |
| Remove the link, then the sink | 32 s and 31 s; 31 s and 31 s |
| Read the cell account's `StressCell` metrics from the platform account with `GetMetricData` and `AccountId`, about two minutes after the cell's log lines | All of them: 24 served, 6 refused, 30 in all; the percentiles of `$.totalMs` (p95 381 ms, p99 388 ms); the retry lines by service; 12 `AWS/Lambda` invocations of a function in the cell account |
| A `SEARCH` over the cell account | Works with the `AccountId` field of the query. The form `:aws.AccountId="..."` inside the search expression returns nothing |
| `GetMetricWidgetImage` on a widget with `accountId` and a search | Renders the cell account's series |
| `ListMetrics` with `IncludeLinkedAccounts` | Returned nothing in the first minutes. The dashboard does not use it: it names its series, or searches with `AccountId` |
| The link creates a role in the cell account | No. `iam list-roles` shows no new role and no service-linked role |
| The account check of spec §3.7 with the link in a stack tagged `stress:part=account-base` and on the owner's list | The check reported seven problems, all about other fleets' stacks and a policy suffix the run's settings did not name (the check ran with the settings of a different fleet); none names the link, its stack or a role. No baseline run without the link was made, so "the link adds none" rests on that and on the missing role |

What is not proven: the link inside the real `CellAccountBase` stack. The stack's template, which a unit test pins,
carries the same properties as `link.yaml`, but `CellAccountBase` in the test account was not redeployed with it,
because it is the account's owner stack for other runs. A cell owner deploys it once with
`OBSERVABILITY_SINK_ARN` (see [`../../dashboard/README.md`](../../dashboard/README.md)).

## SD-2: the relay and its lag

**Result: passed, and much better than the design's estimate.** A minute of load is readable in CloudWatch
5 to 13 seconds after it ended, not about three minutes.

`relay-load.js` made 16 requests a second for 4 minutes, 3,828 requests, through `stress/k6/lib.js`, on the driver
host, with `STRESS_MODE=platform` and `RECORD_SCENARIO=PS-2` as `driver/k6.sh` arguments.

| Minute (UTC) | Calls | Readable at | After the minute ended |
|---|---|---|---|
| 14:06 (partial) | 140 | 14:07:05 | 5 s |
| 14:07 | 956 | 14:08:08 | 8 s |
| 14:08 | 956 | 14:09:10 | 10 s |
| 14:09 | 956 | 14:10:13 | 13 s |
| 14:10 (partial, the last) | 820 | 14:11:05 | 5 s after the stop |

A minute is published when every VU has printed a line for it and a later minute exists, so the 90-second grace
was never used here; it is the bound for a slow VU. The relay polls every 10 seconds.

The totals in CloudWatch equal k6's own counters, to the request: assertions 3,828, mismatches 9, refusals seen 383
and named 383, 2xx 3,445, 4xx 383, `http-429` 383, and 3,828 samples in the latency histogram. The p50 (350 ms) and
p95 (589 ms) are the true figures (about 345 and 580 ms) read to the bucket, which is 12 % wide.

Two findings:

- `RECORD_SCENARIO` is a `NAME=value` argument of `driver/k6.sh`, as `slice.sh` passes it in a platform run. It is not
  taken from the caller's environment. A first run that set it in the environment started no relay and published
  nothing, which the host's output shows (`relay.log` is missing).
- The k6 library change (the minute line) ran on a real k6 host for the first time here: `lib.js` is checked by
  running it, not by the build.

## SD-3: names, filters, searches, the image and the timings

| Check | Result |
|---|---|
| CodeBuild: `Builds`, `FailedBuilds`, `QueuedDuration`, `Duration` | Exist, with a series that has no dimension (account-wide) and one by `ProjectName`. The dashboard reads the account-wide series, so it needs no search |
| Step Functions: `ExecutionsStarted`, `ExecutionsFailed`, `ExecutionThrottled` | Exist, account-wide and by `StateMachineArn`. The dashboard reads the account-wide series |
| CloudFront function metrics (`us-east-1`): `FunctionComputeUtilization`, `FunctionExecutionErrors`, `FunctionThrottles`, `FunctionInvocations` | Exist with `FunctionName` and `Region`; there is no series without `FunctionName`, so the dashboard searches. **`FunctionValidationErrors` is not listed**, so it is not on the dashboard (the design named it) |
| CloudFront distribution: `Requests`, `4xxErrorRate`, `5xxErrorRate` | Exist with `DistributionId` and `Region` only, no account-wide series, so the dashboard searches |
| Front door `RouteTableBytes` | Exists with and without `DistributionId`; the dashboard reads the series without |
| AgentCore Runtime: sessions, invocations | `Sessions` and `Invocations` have a series with `AggregateOperation=InvokeAgentRuntime`; `ActiveSessionCount` with `Service=AgentCore.Runtime`. **`Throttles` has no aggregate series**, only by `Operation` and `Protocol` (and more), so the dashboard sums a search |
| Cognito | `AWS/Cognito` has `SignInThrottles` with `UserPool` and `UserPoolClient`. It is **not wired** to the `cognito-user-authentication-rps` quota: nothing shows that it counts that quota's category, so that quota's panel shows the planned draw and the limit only |
| A metric filter that publishes `$.totalMs`, and CloudWatch computes p95 and p99 | Works (SD-1) |
| A metric filter with a dimension read from a numeric JSON field (`$.status`) | Works: the series are `Status=200` and `Status=429` |
| A `SEARCH` finds a metric created minutes before | Yes, a cross-account series about two minutes after its first data point. The 15-minute listing delay the design allowed for did not show; it is not ruled out for a new account |
| A `RunId` variable in the dashboard body | `PutDashboard` accepts it and `GetDashboard` returns it. Its **rendering was not checked** (no console here), and the dashboard does not use it: it names the run's id, and `run.sh dashboard up --run` deploys a past run again |
| `GetMetricWidgetImage` renders a cross-account widget | Yes (SD-1), and the 24 images of a run render with no error, empty where a series has no data |
| The dashboard as a CloudFormation stack with one dashboard (`dash.yaml`) | 36 s to deploy, 31 s to remove |
| The dashboard as the CDK app (`dashboard/app.ts`) | 20 s to deploy with the `AWS::CDK::Metadata` marker, 19 s without it (the app turns it off), 31 s to remove |
| The `sdk retried` line of the authoriser and each interceptor reaches `SdkRetryLines` | The filter and a synthetic `sdk retried` line reach the metric (2 `kms` lines counted). The cell app's synthesised template has the filter on the ingress, the authoriser and both interceptor log groups. The real components' lines were **not** run, because that needs a deployed cell |

## What did not run

- A full platform run (all four slices, a real cell, the edge): the PS-1 to PS-8 widgets of rows B and D7, the front
  door's, the control plane's and AgentCore's, show no data in the proof run and are checked only by rendering without
  error. The live proof is the `tenant-identity` slice at `small` and the synthetic relay load above.
- The cost of a platform run: only the series counts of a slice run were measured (see the dashboard README).
