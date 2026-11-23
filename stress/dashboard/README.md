<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# The run dashboard

One CloudWatch dashboard that shows a platform stress run while it runs and after it: isolation
mismatches, refusals, request counts, latency, the edge, the platform account, each cell account and
the headroom on the budgeted quotas. The design is
[`docs/stress-dashboard.design.md`](../../docs/stress-dashboard.design.md), the decision is
[stress ADR-0022](../adr/0022-show-a-run-on-one-dashboard-in-the-platform-account.md). The dashboard
is a view: it decides no pass criterion, and the result records stay the record of the run
([spec §7](../../docs/stress-test.spec.md)). It is a test asset, deployed for a run and removed after
it, and part of no sample's stacks.

## What you get

| Part | File | What it is |
|---|---|---|
| The dashboard | [`dashboard.cdk.ts`](./dashboard.cdk.ts), [`app.ts`](./app.ts) | One stack, `<STRESS_PREFIX>-dashboard`, with one `AWS::CloudWatch::Dashboard`, `<STRESS_PREFIX>-run`. Nothing else: no function, role, log group or custom resource, so CloudFormation removes all of it |
| The widgets, as data | [`widgets.ts`](./widgets.ts) | Every widget with its CloudWatch properties. The stack lays them out and the snapshot step renders the same properties as images |
| The plan | [`plan.ts`](./plan.ts) | What the dashboard is built from: the runner writes it to the run folder when the run starts |
| The lifecycle | [`dashboard.sh`](./dashboard.sh) | `up`, `snapshot`, `down`; `down` checks that the stack and the dashboard are gone |
| The snapshots | [`snapshot.ts`](./snapshot.ts) | One PNG for each metric widget, for the run's window, saved in the run folder |
| The sink | [`sink.cdk.ts`](./sink.cdk.ts), [`deploy-sink.sh`](./deploy-sink.sh), [`remove-sink.sh`](./remove-sink.sh) | The platform account's observability sink: a fixture that holds no data and costs nothing idle |
| The `StressRun` metrics | [`../src/metrics.ts`](../src/metrics.ts) | The emitter, with an allowlist of dimension names and values |
| The relay | [`../k6/relay.sh`](../k6/relay.sh) | Publishes each minute of a k6 scenario while k6 runs |
| The cell's metric filters | [`../application/cell-metrics.ts`](../application/cell-metrics.ts) | `StressCell` metrics read off the cell's own log lines |
| The link | `CellAccountBaseStack` in [`../application/cell-account.cdk.ts`](../application/cell-account.cdk.ts) | One observability link in each cell account's account base |

Where each number comes from:

| Source | Account and Region | Reached by |
|---|---|---|
| `StressRun`: the runner's counts (scenario strip, isolation totals, deploy and destroy seconds, quota plan) | platform, the run's Region | `aws cloudwatch put-metric-data` from the runner |
| `StressRun`: the driver's counts (requests, isolation, refusals, latency) | platform, the run's Region | the relay on the driver host, while k6 runs |
| `StressRun`: onboarding and churn times, builds in flight | platform, the run's Region | the control-plane slice, through `run.sh emit` |
| `StressCell`, `AWS/Lambda`, `AWS/Bedrock-AgentCore` of a cell account | each cell account, the run's Region | the sink in the platform account and one link in each cell account |
| Router and distribution | platform, `us-east-1` | native CloudFront metrics, found by search |
| CodeBuild, Step Functions, Lambda, API Gateway, route table | platform, the run's Region | native metrics |

## Set it up, once

You need the platform account's credentials and, for each cell account, its owner's. The Region is
the run's Region; a sink and a link work inside one Region, so a second Region needs a second pair.

1. The sink, as the platform account's owner, from `stress/`:

   ```bash
   export AWS_REGION=eu-west-2 STRESS_CELL_ACCOUNTS=/path/to/cell-accounts.json
   dashboard/deploy-sink.sh
   ```

   It prints `SinkArn=<arn>`. The sink's policy names the account ids of the cell accounts file and
   allows only metric links. Run it again after you add a cell account.

2. The link, as each cell account's owner: deploy `CellAccountBase` again with the sink's ARN. **Repeat
   every variable of the first deploy.** `CellAccountBase` writes the identity parameters only when it is
   given `CELL_USER_POOL_ID` and `CELL_APP_CLIENT_ID`, and a deploy without them deletes the two parameters
   the cells read; the same goes for `PLATFORM_ACCOUNT_ID` (the ingress reader role), `CELL_POLICY_SUFFIX` and
   `CELL_OWNER_STACKS=base` (a second Region).

   ```bash
   export AWS_REGION=eu-west-2 OBSERVABILITY_SINK_ARN=<the SinkArn>
   export PLATFORM_ACCOUNT_ID=<platform account id> CELL_USER_POOL_ID=<stress identity pool id> CELL_APP_CLIENT_ID=<its app client id>
   application/deploy-owner.sh
   ```

   The link shares the account's `AWS/Lambda`, `AWS/Bedrock-AgentCore` and `StressCell` metrics, no
   log group. It creates no role in the cell account. Run the account check
   ([spec §3.7](../../docs/stress-test.spec.md)) before and after, and compare: the link is a resource of a stack
   on the owner's list and the spike's check named no problem about it, but the spike ran the check without a baseline
   and not on the real `CellAccountBase` (see [the spike results](../spikes/dashboard/README.md), SD-1).

3. The driver host must have the `PutMetricData` statement: deploy the driver stack again if it is older than this
   change (`driver/deploy.sh`); an old host gives `AccessDenied` for every minute and the relay tries the
   oldest pending minute every poll, logging one line each time. The platform account must be CDK-bootstrapped for the Region,
   as for the driver.

4. Nothing else. A cell build adds the `StressCell` metric filters itself
   ([`../application/cell-metrics.ts`](../application/cell-metrics.ts)); the driver stack gives its host
   `cloudwatch:PutMetricData` limited to the `StressRun` namespace.

## Run with it

A platform run (several slices) turns the dashboard on. It needs `AWS_REGION`, the platform account's
Region, in the environment, and `STRESS_CELL_ACCOUNTS` for the cell widgets.

```bash
cd stress
export AWS_REGION=eu-west-2 STRESS_CELL_ACCOUNTS=/path/to/cell-accounts.json
./run.sh run --tier small --slices tenant-identity,control-plane,tenant-front-door,agentic-runtime-isolation --limits limits.json
```

| Flag | Effect |
|---|---|
| (none, platform run) | The runner deploys the dashboard after `budget` passes and before the first slice `deploy`, publishes while it runs, takes the snapshots after the last teardown and removes the dashboard |
| `--dashboard` | The same for a slice run. A slice run has no front door and no cell account, so only the runner's own series have data |
| `--no-dashboard` | No dashboard and no metrics, as before: the runner does not set `STRESS_METRICS`, so the relay does not start on the host either |
| `--keep-dashboard` | Keep the dashboard after the run (about $3 a month while it stays). The snapshots are taken anyway. The next run's dashboard has the same stack name and replaces it |
| `--remove-fixtures` | Also removes a dashboard kept by an earlier run, when this run has the dashboard on: `--keep-dashboard` is ignored |

Without `STRESS_CELL_ACCOUNTS` the run goes on, with a warning, and the dashboard shows no cell account.
`dashboard.sh` updates and deletes a stack named `<prefix>-dashboard` only when it carries the tag
`stress:part=run-dashboard`, which the dashboard app gives it; any other stack of that name is left alone and the
step fails. `run.sh report <results dir>` renders a results file from the records alone, so it has no verdict
and no "Dashboard" section: use the `results.md` the run wrote.

A failed dashboard step never fails a run: the metrics are a view. A dashboard that cannot be removed
does, because it is a leftover. The run writes a `dashboard` row in the deploy and destroy table of its
results file, a "Dashboard window" line for each scenario and a link built from the dashboard's name and
Region (no account id).

The runner writes `dashboard-plan.json` in the run folder (`$STRESS_HOME/$STRESS_PREFIX/<run id>/`) and the
snapshots in `dashboard/` beside it. Neither is committed.

### See a run again

The dashboard is removed after the run, but the metrics stay in CloudWatch for their retention (one-minute
points 15 days, five-minute points 63 days). Deploy it again for a run:

```bash
cd stress
AWS_REGION=eu-west-2 STRESS_CELL_ACCOUNTS=/path/to/cell-accounts.json ./run.sh dashboard up --run <run id>
./run.sh dashboard snapshot --run <run id>
./run.sh dashboard down --run <run id>
```

It shows the run's window (the plan holds it). The widgets that search for a metric by name (the router,
the distribution, the identity API) show nothing for a run more than 14 days old: CloudWatch does not list a
metric with no data for two weeks. The PNG snapshots are the view of such a run.

### Remove a kept dashboard

`./run.sh dashboard down --run <run id>`, or the next run with `--remove-fixtures`. Remove the sink last,
after every cell account's link is gone: `AWS_REGION=eu-west-2 dashboard/remove-sink.sh` (it refuses while a
link is attached).

## Reading it

| Row | Widgets | What to look at |
|---|---|---|
| A, the run | scenario strip, isolation, refusals, requests, reasons, latency, onboarding, churn, deploy and destroy seconds | **Isolation mismatches must stay 0.** "Unattributed" is the driver's refusals minus those that name a tenant and a status or reason; the run fails when it is not 0 |
| B, the edge | router compute, router errors, distribution, route table | Compute at 100 % means the router is throttled |
| C, the platform account | builds, workflow, identity API, Lambda | Failed builds and throttled executions in PS-1 and PS-5 |
| D, each cell account | ingress, latency, refusals, Lambda, SDK retries, AgentCore | D6 sets the driver's 2xx against the cells' 200: compare the totals over a scenario, not one minute |
| E, quotas | one panel for each budgeted quota, and the peaks | A quota with a retry signal only (STS, KMS) shows that calls were retried, not a rate |

A live widget trails a minute of load: the relay publishes a minute when every VU that has printed a line has
printed one for it and a later minute exists, or 90 seconds after it ended, and CloudWatch adds its own delay.
In the spikes that was 3 to 19 seconds (spike SD-2, with SD-2's load; a VU that has nothing to do for a while
makes it wait for the 90 seconds). What arrives after a minute went out is published as an addition. At tier
`small` a scenario lasts one minute, so its counts show a little after it ended. A 60-second period shows the
5-second herd of PS-3 as one point. The A3 live gap (driver count against the cells' count) trails by up to 5 seconds
for each VU, because a VU prints every 5 seconds: it is not final until the scenario has ended and its last
minute has been published.

## Spike results

The spikes of [design §12](../../docs/stress-dashboard.design.md) ran on 2026-11-23 against a test platform
account and a test cell account, and their results are in
[`../spikes/dashboard/README.md`](../spikes/dashboard/README.md).

## Known limitations

- **The dashboard decides nothing.** The driver's count and the dashboard's are the same arithmetic in platform
  mode (design §5), so the dashboard cannot catch a driver bug. D6 sets the driver's 2xx against the cell's own
  count, which can.
- **A cell build can forge `StressCell`.** The cell's execution policy grants `cloudwatch:*`, so a cell build
  can publish its own numbers. That is why `StressCell` is for the view and never a pass criterion.
- **One Region.** A sink and a link work inside one Region. A cell account in a second Region needs its own
  pair (design §2).
- **No tenant on the dashboard.** Per-tenant metrics stay off (runtime-isolation ADR-0021). The record's
  `refusals.byTenantReason` and the cell's Contributor Insights rules answer which tenant.
- **No Contributor Insights widget.** CloudWatch documents no way to read a rule that lives in a cell account.
- **The relay is not run at `medium` or `large`.** Those tiers need Q-7 (spec §10). The relay's published
  series and the widgets are the same; its lag and cost at a higher rate are not measured.
- **Searched widgets lag.** The router, the distribution and the identity API are found by search, because the
  dashboard is deployed before the front door exists; a metric is listed up to 15 minutes after its first data
  point.
- **The AgentCore throttle line is unverified.** `Throttles` has no aggregate series, so D7 sums a search over the
  series with the dimensions `Operation` and `Protocol`, one of several sets. No cell account has produced a throttle
  to show it returns data, and a series with other dimensions (`Resource`, `Name`, `TargetType`) is not in it.
- **A VU's last calls can go unprinted.** k6 has no per-VU end hook. A VU prints what it counted every 5 seconds, at the
  end of a minute, and in the last 5 % of a scenario a second after its last print, always at the first call of an
  iteration and on the other calls of that iteration, so a request is never split. What a VU counts after its last
  print is lost, as whole requests: up to 1 second of its requests when it is called in the last 5 %, up to 5 seconds
  when it is not. The live counts of the last minute can therefore be a little low. For 16 requests a second, one
  request an iteration and requests handed out round robin, a simulation of 100 VUs for one minute (tier `small`) lost
  0 to 52 of 960 requests, by the second the load began in, and over 240 seconds none. The loss grows with the VUs in
  use and with the requests an iteration (100 VUs, three requests an iteration, 240 seconds: up to 105 of 3,839) and
  shrinks with the length of the run. The result records are not affected.
- **A replaced output file.** The relay reads k6's output file by line count; k6 only appends to it. A file that is
  replaced is not handled: a shorter one is read from its first line, a longer one loses its first lines.
- **The relay has a bound.** It ends itself when its parent script ends or after `K6_TIMEOUT` plus 300 seconds, and the
  script ends it on exit, so a cancelled Run Command does not leave one publishing under an old run id. The first pass
  over a very large output file (200,000 refusal lines, 29 MB) takes about 9 seconds; a pass reads only the lines that
  are new.
- **A slice with its own k6 caller.** The relay sets `Slice` to `agentic-runtime-isolation`, the only slice that
  calls `driver/k6.sh` in platform mode. A second caller needs a `RELAY_SLICE` setting from its `run` verb.
- **Quota signals.** STS, KMS and the AgentCore rate quotas have a retry or throttle signal and no rate. The
  Cognito cap on groups is shown by the planned draw only.
- **Review.** A hardened component, not a production one. It has had no independent human review.

## Security scan

ProtoShield (v0.18.0, with the stress folder's own config, so the license check is for MIT-0) ran on the files of the
dashboard build: 0 critical, secrets 0, Semgrep 0, CVE 0, license headers 0. Its IAM check reports high findings, and
which ones it names differs from scan to scan (one to five). The statements it names are these; none is fixed, for
these reasons:

| Finding | Where | Why it stays |
|---|---|---|
| `cloudwatch:PutMetricData` on `*` | `PublishRunMetrics`, driver host role | The action has no resource type, so IAM takes only `*`. The condition `cloudwatch:namespace` limits it to `StressRun`, and a test pins both |
| `ec2messages` and `ssmmessages` on `*` | `SsmAgentMessages`, driver host role | Existing (stress ADR-0009): those actions have no resource type |
| `execute-api:Invoke` on every API, SSM parameter prefixes, the ingress reader's cell-id wildcard | `InvokeApis`, `ReadPublishedParameters` (driver host role), `ReadCellIngressParameters` (cell account) | Existing statements this work does not change, documented where they are made |

The sink policy's `Resource` is the account's sinks in the Region (`sink/*`), not `*`: an earlier scan named it and it
was narrowed. The scan was of a folder of the changed files, because a scan of a whole folder runs the tool out of
tokens.

## Build

```bash
cd stress
npm ci
npx projen build
```
