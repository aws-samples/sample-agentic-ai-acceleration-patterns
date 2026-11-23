<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0022: Show a run on one dashboard in the platform account

- Status: Proposed
- Date: 2026-11-23
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md), and "design"
means [`docs/stress-dashboard.design.md`](../../docs/stress-dashboard.design.md).

A run's numbers reach a person only after it ends: result records, then the
results file (spec §4.3). In platform mode the runtime-isolation slice joins
no hop log and no metric, so the records hold the client's latency hops and
no quota peaks (`stress/README.md`, known limitations). Nobody sees the
isolation count, the refusals or the headroom on the shared quotas while a
scenario runs. The platform spans four places that each hold part of the
picture:

| Place | Holds | Region |
|---|---|---|
| Platform account | control plane, CodeBuild, front-door registrar and route table, stress identity | the run's Region |
| Platform account, edge | CloudFront distribution and the router function | `us-east-1` |
| Cell account 1 (and 2 at `medium` and `large`) | the ingress, authoriser, agents, tools, the cell API origin | the run's Region |
| A process on the driver host (in the platform account) | what k6 counts: requests, isolation mismatches, refusals | the run's Region |

The decision is where a person looks, and how the other places feed it. The
constraints are the spec's: a cell account holds four kinds of stack and
nothing else (spec §3.7), a cell build can change any cell in its account
and no more, per-tenant custom metrics stay opt-in (runtime-isolation
ADR-0021), and a run leaves nothing behind (spec §7).

## Options considered
### Option 1: One dashboard in the platform account, cell accounts shared through cross-account observability
Each cell account's owner adds one observability link to the account base,
and the platform account holds one sink in the run's Region. The dashboard
reads cell metrics by account id, the edge metrics by Region (`us-east-1`,
same account), and the driver's counts from a `StressRun` namespace the
driver host and the runner publish in the platform account.
Pros: one place to look; no data points are copied; no charge for the sharing; the link
shares only the namespaces it names; a cell build cannot change it, because
the cell execution policy grants no `oam:*` action. Cons: a link and a sink
are one more owner step in every cell account (spec §3.7); links and sinks
work inside one Region, so a cell account in a second Region needs its own
pair; whether the account check of spec §3.7 accepts the link is unproven.

### Option 2: One dashboard in the platform account, cell accounts reached through the cross-account console roles
Each cell account's owner adds a sharing role that the platform account's
CloudWatch may assume. Pros: crosses Regions as well as accounts. Cons: metrics
and alarms only; it cannot show a log or a Contributor Insights widget from the
cell; the role is an IAM role in the cell account, and spec §3.7 reads every
role there; CloudWatch documents no programmatic access to it.

### Option 3: One dashboard per account
The runner deploys a dashboard in each account. Pros: nothing shared between
accounts; each dashboard reads only native metrics. Cons: the runner has no
deploy right in a cell account (it holds a role pair and a reader role only),
so each cell account needs a new stack kind and its owner to deploy it; a
person reads three consoles to follow one request; the reconciliation of
driver count against cell count (design, widget D6) cannot be drawn.

### Option 4: Republish cell metrics into the platform account
The runner reads each cell account's metrics through a reader role and writes
them to `StressRun`. Pros: no sink or link. Cons: a cell account role to
review (like the ingress reader), a poll loop that is test code to keep
correct, a lag of one poll plus CloudWatch's own, and it copies data.

### Option 5: Amazon Managed Grafana, or Logs Insights widgets only
Pros: Logs Insights can show any field of a log line. Cons: Grafana adds a
workspace, a sign-in setup and a service role that must be removed again, and
it still needs cross-account roles; Logs Insights is billed per gigabyte
scanned on every dashboard refresh and has no live aggregate across accounts
without the same link as Option 1.

## Decision
Option 1, in two layers.

- Fixtures, once per account, owned by the account owner: the sink in the
  platform account, and one link in each cell account's account base, limited
  to the namespaces the dashboard reads (`AWS/Lambda`,
  `AWS/Bedrock-AgentCore`, `StressCell`). They hold no data and cost nothing idle.
- Per run, owned by the runner: one stack in the platform account with one
  `AWS::CloudWatch::Dashboard` and nothing else (no function, role, log group
  or custom resource), deployed after `budget` passes and before the first
  slice `deploy`, destroyed after the last slice `teardown` unless
  `--keep-dashboard` is given.

The dashboard reads three kinds of source. Native service metrics. A `StressRun`
namespace the runner and the driver host publish, with the dimensions `RunId`,
`Slice`, `Scenario`, `StatusClass`, `Phase`, `Account`, `Quota` and `Reason`, and never a tenant,
user, agent or token. A `StressCell` namespace that metric filters in each cell
publish from the cell's own structured log lines, with no tenant dimension. The
stress cell app adds the filters (`stress/application/cell-app.ts`); the
runtime-isolation sample does not change. Per-tenant metrics stay off, and the
dashboard shows no tenant: the record's refusals by tenant, and the Contributor
Insights rules the cell already has (read in the cell account), answer that. A
Contributor Insights widget on the dashboard would need the link to share the
cell's log groups and rules in the platform account, which this decision does not
do (design §7).

## Consequences
Easier: a person sees isolation mismatches, refusals, per-hop latency and quota
headroom about three minutes after each minute of k6 load (unmeasured; so at
`small`, whose scenarios last one minute, a scenario shows as the next one runs),
and the driver's count can be set against the cell's own count. The dashboard stack has nothing
that leaks (design §8).

Harder: each cell account owner makes one more change before the first run,
and the account check must still pass with it (design §11 and §14, unproven). The
driver host role gains `cloudwatch:PutMetricData` limited to the `StressRun`
namespace. The dashboard never decides pass or fail: the result records stay
the record of the run (spec §7), and the two can differ.

Revisit when a spike shows the link breaks the account check, when a cell
account is needed in a second Region (a second sink and link pair, or
Option 2), or when a run needs a window of metrics older than the metric
retention.
