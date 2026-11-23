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

2. The link, as each cell account's owner: deploy `CellAccountBase` again with the sink's ARN.

   ```bash
   export AWS_REGION=eu-west-2 OBSERVABILITY_SINK_ARN=<the SinkArn> PLATFORM_ACCOUNT_ID=<platform account id>
   application/deploy-owner.sh
   ```

   The link shares the account's `AWS/Lambda`, `AWS/Bedrock-AgentCore` and `StressCell` metrics, no
   log group. It creates no role in the cell account. Check with the account check
   ([spec §3.7](../../docs/stress-test.spec.md)) before the next run: the link is a resource of a stack
   on the owner's list, so it passes (spike SD-1, below).

3. Nothing else. A cell build adds the `StressCell` metric filters itself
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
| `--no-dashboard` | No dashboard and no metrics, as before |
| `--keep-dashboard` | Keep the dashboard after the run (about $3 a month while it stays). The snapshots are taken anyway |
| `--remove-fixtures` | Also removes a dashboard kept by an earlier run: `--keep-dashboard` is ignored |

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

A live widget trails a minute of load: the relay waits until every VU has finished a minute or 90 seconds
after it, and CloudWatch adds its own delay. At tier `small` a scenario lasts one minute, so its counts show
after it ended. A 60-second period shows the 5-second herd of PS-3 as one point.

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
- **`SEARCH` over a cell account.** AgentCore throttles are found by search in each cell account.
- **A slice with its own k6 caller.** The relay sets `Slice` to `agentic-runtime-isolation`, the only slice that
  calls `driver/k6.sh` in platform mode. A second caller needs a `RELAY_SLICE` setting from its `run` verb.
- **Quota signals.** STS, KMS and the AgentCore rate quotas have a retry or throttle signal and no rate. The
  Cognito cap on groups is shown by the planned draw only.
- **Code Bar.** A hardened component, not a production one. A human SA peer review has not happened.

## Build

```bash
cd stress
npm ci
npx projen build
```
