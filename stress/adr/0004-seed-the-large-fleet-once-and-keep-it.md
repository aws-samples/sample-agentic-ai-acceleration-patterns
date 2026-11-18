<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0004: Seed the `large` fleet once and keep it

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
A tenant onboarded through the control plane runs one tenant build in
CodeBuild, about one to two minutes each. At the control plane's build
limit of 5, 4,000 tenants take about 20 hours; at 50 (control-plane
ADR-0046) about 2 hours. A platform run should fit inside a working day,
and Cognito bills a user once a month however many runs it serves.

## Options considered
### Option 1: Onboard every tenant on every run
Pros: the real path every time; nothing kept between runs. Cons: about 2
hours of onboarding before the first request at `large`; 4,000 builds and
4,000 deletes per run; a failed run leaves thousands of tenants to unwind.

### Option 2: Seed directly, bypassing the control plane
Pros: today's runtime-isolation seed time (about 21 minutes). Cons: the
route registrar accepts a route only for a cell the control plane placed,
so direct seeding needs a test-only path around a security check.

### Option 3: Seed once through the control plane, keep the fleet, churn a slice each run
Pros: runs stay at about today's length; onboarding, edge traffic and churn
are all tested; no bypass. Cons: a fixture that can drift; idle cost of the
cells and the edge between runs.

## Decision
Option 3 at `large`. The first `large` run seeds 4,000 tenants through the
control plane and records them in the manifests (spec §4.2). Later runs
check the fleet first (every manifest tenant `ACTIVE`, routed and
subscribed), repair what is missing, and onboard only the churn count (100)
under load. `small` and `medium` onboard every tenant on every run. The
fleet is torn down only with `teardown --fixtures`.

## Consequences
Easier: a `large` run costs traffic time, not onboarding time. Harder: the
fleet's health check must run before every `large` run; a change to the
cell or tenant scripts means reseeding or updating the fleet, which is
itself a test of `UpdateCell` and `UpdateDeployment`. Revisit when the idle
cost of the fleet (spec Q-3) is known, or when onboarding gets fast enough
to run every time.
