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
account check of spec §3.7 named no problem about the link (it ran without a baseline and reported seven unrelated problems, below).

| Check | Result |
|---|---|
| Deploy the sink (platform account) and the link (cell account) | 36 s and 37 s; 37 s and 36 s in a second Region |
| A sink policy whose `Resource` is the account's sinks (`arn:...:oam:<Region>:<account>:sink/*`) instead of `*` | Accepted, and the link was created with it (36 s). The policy is part of the sink, so it cannot name the sink's own ARN. `sink.yaml` and the CDK sink use this form; the first runs above used `*` |
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

**Result: passed for this load (50 to 100 VUs in use, 16 requests a second, 4 minutes).** A full minute of load is
readable in CloudWatch 3 to 19 seconds after it ended with the final code (at a 10-second poll), not about three
minutes, and the totals equal k6's own to the request. The first, partial minute of a run can wait for the relay's 90
second grace (`sd2h`: 100 seconds), because a VU that has not printed for it yet holds the minute back. How much the
last seconds of a shorter scenario lose is a property of the print rule and is given below.

`relay-load.js` makes 16 requests a second for 4 minutes (3,840 to 3,841 requests) through `stress/k6/lib.js`, on the
driver host, with `STRESS_MODE=platform`, `STRESS_METRICS=1` and `RECORD_SCENARIO=PS-2` (an argument of `driver/k6.sh`),
as a `constant-arrival-rate` load of up to 100 VUs (the shape of the scenarios). The lag is the time from the end of a
minute to the first poll (every 10 seconds, `get-metric-data`, period 60) that returned a value for it. Six runs are
listed. The first, `sd2h`, ran the committed code (`stress/k6/minute.js`, `lib.js` and `relay.sh`; k6 v2.4.0 on the
host). `sd2g` ran the same code without two later rules (an iteration stays in the minute of its first count, and a VU
forgets the iteration of its previous scenario), which unit tests cover. `sd2f` ran the same relay with a print rule
that decided once per iteration in the last 5 % only. The three after them ran earlier versions and are kept for the
lag, and for what each print rule loses.

| Run | Minute (UTC) | Assertions at the first read | Readable at | After the minute ended |
|---|---|---|---|---|
| `sd2h`, the final code | 17:10 (partial, the load began at 17:10:56) | 30 | 17:12:40 | 100 s (the grace) |
| | 17:11 | 960 | 17:12:19 | 19 s |
| | 17:12 | 960 | 17:13:11 | 11 s |
| | 17:13 | 913 | 17:14:03 | 3 s |
| | 17:14 (partial, the last) | 931 | 17:15:06 | 6 s |
| `sd2g`, the print rule without the two later rules | 16:33 (partial, the load began at 16:33:24) | 513 | 16:34:18 | 18 s |
| | 16:34 | 960 | 16:35:10 | 10 s |
| | 16:35 | 960 | 16:36:12 | 12 s |
| | 16:36 | 913 | 16:37:04 | 4 s |
| | 16:37 (partial, the last) | 448 | 16:37:35 | at the stop |
| `sd2f`, the decision once per iteration in the last 5 % only | 16:12 (partial, the load began at 16:12:24) | 87 | 16:13:12 | 12 s |
| | 16:13 | 960 | 16:14:15 | 15 s |
| | 16:14 | 960 | 16:15:07 | 7 s |
| | 16:15 | 960 | 16:16:10 | 10 s |
| | 16:16 (partial, the last) | 874 | 16:17:02 | at the stop |
| `sd2e`, once a second in the last 5 %, decided at each count (a request split) | 15:50 (partial, the load began at 15:50:24) | 563 | 15:51:14 | 14 s |
| | 15:51 | 960 | 15:52:06 | 6 s |
| | 15:52 | 960 | 15:53:09 | 9 s |
| | 15:53 | 960 | 15:54:11 | 11 s |
| | 15:54 (partial, the last) | 347 | 15:54:32 | at the stop |
| `sd2d`, a print on every call in the last 5 % | 15:07 (partial, the first) | 108 | 15:08:11 | 11 s |
| | 15:08 | 960 | 15:09:13 | 13 s |
| | 15:09 | 960 | 15:10:16 | 16 s |
| | 15:10 | 960 | 15:11:08 | 8 s |
| | 15:11 (partial, the last) | 842 | 15:12:00 | at the stop |
| `sd2a`, 4 VUs, `constant-vus`, a first version of the relay | 14:07 | 956 | 14:08:08 | 8 s |
| | 14:08 | 956 | 14:09:10 | 10 s |
| | 14:09 | 956 | 14:10:13 | 13 s |

The first-read values of `sd2h` and of `sd2g` add up to 3,794 and their total in the end was 3,841; those of `sd2d` add up to 3,830
and its total in the end was 3,841. A line that came after its minute went out is published as an addition (design §5),
so a first read can be lower than the minute's final value. The `sd2f` values add up to 3,841 and the `sd2e` values to
3,790, the totals CloudWatch held at the end. A first-read lag is the time to the first data of the minute, not to the
last, and each lag figure is up to 10 seconds above the real one (the poll interval).

A minute is published when every VU that has printed a line has printed one for it and a later minute exists, or 90
seconds after it ended; the 90 seconds were not used. The relay polls every 10 seconds. With 50 to 100 VUs, each
idle between its iterations, every VU still printed within the minute (a VU that is called prints at least every 5
seconds), so the "all VUs" rule held for the full minutes. A VU that has not printed for a minute yet makes the relay
wait the 90 seconds: that happened to the first, partial minute of `sd2h` (100 seconds), where the VUs of the pool
start at different seconds. It is the bound the design gives for a slow VU, not a defect.

Totals of `sd2h` in CloudWatch against k6's own counters (`sd2g` and `sd2f` gave the same):

| | CloudWatch | k6 |
|---|---|---|
| Isolation assertions | 3,841 | 3,841 |
| Samples in the latency histogram | 3,841 | 3,841 |
| Isolation mismatches | 9 | 9 |
| Refusals seen, and named | 385 and 385 | 385 |
| 2xx, 4xx, `http-429` | 3,456, 385, 385 | 3,456, 385, 385 |

The p50 (351 ms) and p95 (589 ms) are the true figures (about 345 and 580 ms) read to the bucket, which is 12 % wide.

What the print rules lost in the last seconds of this load. k6 has no per-VU end hook, so what a VU counted after its
last print is lost. A request makes three counts (its status, its timing and its assertion), one after the other.
`sd2e` printed at most once a second in the last 5 % and decided at each count: a VU that is used less than once a
second printed the status of its last request and kept the other two, so the totals came out 50 short (3,790
assertions and latency samples of 3,840 requests, 1.3 %) while the 2xx and 4xx totals were exact. Simulating the rule
found the cause, and showed the same split outside the last 5 % for a VU that is idle there. The final rule decides
once for an iteration, in every phase: a print that begins in an iteration goes on for every count of it
(`stress/k6/minute.js`, `bump`; the tail is a print at most a second after the last). `sd2f`, `sd2g` and `sd2h` lost
nothing. `sd2h` printed 4,173 `minute` lines for 3,841 requests (11,523 counts); a k6 that gave no iteration number
would print one line a count, so the property is read on the host.

What is still lost is whole requests of a VU that is idle at the end. For 16 requests a second, one request an
iteration and requests handed out round robin, a simulation of 100 VUs for one minute (the `small` tier) lost 0 to 52
of 960 requests, by the second the load began in, and none over 240 seconds with 50 or 100 VUs. The loss grows with the
VUs in use and with the requests an iteration. The result records, which k6's own summary and the hops' logs feed, are
not affected.

The relay was checked on a file of 200,000 refusal lines (29 MB): the first pass took 9 s, and a pass over 100 new
lines 0.05 s, because a pass reads only the new lines.

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

## The cell app's filters

The cell app (`stress/application/cell-app.ts`) was synthesised on 2026-11-23 with the sample's own
`node_modules`, as the cell build runs it (`CELL_ID` set, no distribution). The template held 18 metric filters
in `StressCell`: `IngressRequests` (with `Status`, and a total), `IngressServedMs`, `IngressTtfbMs`, `IngressRefused`
(with `Reason` and `Status`, and a total), `AuthorizerRefused` (with `Reason`, and a total), `AuthorizerTokenRefused`,
`MintLookups` (with `Mint`), and `SdkRetryLines` four times, with and without `Service`: on the ingress, the
authoriser and the two tools interceptors. No filter had a tenant, user, agent or token dimension. The app was not
deployed: that needs the cell build.

## What did not run

- A full platform run (all four slices, a real cell, the edge): the PS-1 to PS-8 widgets of rows B and D7, the front
  door's, the control plane's and AgentCore's, show no data in the proof run and are checked only by rendering without
  error. The live proof is the `tenant-identity` slice at `small` and the synthetic relay load above.
- The cost of a platform run: only the series counts of a slice run were measured (see the dashboard README).
