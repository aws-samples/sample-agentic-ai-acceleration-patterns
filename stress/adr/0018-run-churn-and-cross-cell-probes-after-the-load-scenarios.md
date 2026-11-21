<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0018: Run churn and cross-cell probes after the load scenarios

- Status: Proposed
- Date: 2026-11-21
- Amends: ADR-0004
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md).

The platform scenarios PS-5 (tenant churn through the edge) and PS-7
(cross-cell probes) were meant to run beside the steady load of PS-2.
ADR-0004 likewise has later `large` runs onboard the churn count under
load. The runner runs scenarios one after another: it starts one
scenario's verbs, waits for them, and starts the next. A scenario that
should run beside another needs a second driver process, a shared clock
and a way to attribute each refusal to the scenario that caused it.

## Options considered
### Option 1: Run PS-5 and PS-7 beside PS-2
Pros: the churn writes reach the edge while it serves traffic, as in
production. Cons: the runner needs concurrent scenarios, which no slice
contract (spec §3.4) or result record (spec §4.3) is built for; refusals
caused by churn mix with the refusals the load scenario counts (P-7).

### Option 2: Run PS-5 and PS-7 on their own, after PS-4 and PS-6
Pros: no runner change; each scenario's refusals and timings are its own;
PS-5's time to routable and to suspended is not mixed with the edge's
load latency. Cons: the test does not show whether a churn write still
reaches the edge promptly while the edge serves PS-2's rate.

## Decision
Option 2. PS-5 runs on its own after PS-4, and PS-7 on its own after PS-6
(spec §5.1). At `large`, PS-1 onboards the churn count before the load
scenarios start, not under load (spec §3.3, §5.1). The load shapes PS-2,
PS-3, PS-4, PS-6 and PS-8 run alone. The spec lists the narrowing under
what the test does not do yet (spec §1.2).

## Consequences
Easier: every scenario's pass criterion and refusal attribution stays its
own, and the runner stays sequential. Harder: the test does not show the
effect of churn on traffic, nor of traffic on the time to routable.
Revisit when the runner can run two scenarios at once, or when a platform
run shows a churn delay that only load explains.
