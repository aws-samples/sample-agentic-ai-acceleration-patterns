<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Split the agents across cells

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
The front door exists to route tenants to many cells across accounts, so
the platform run needs more than one cell. Each cell is one
runtime-isolation deployment: an ingress, its agents and its tool targets.
The runtime-isolation `large` tier runs 100 agents behind one ingress. At
100 agents per cell, four cells would be 400 Runtimes and a deploy of 30 to
40 minutes, and four times the Runtime cost while idle.

## Options considered
### Option 1: One cell
Pros: cheapest; the same fleet as the runtime-isolation runs. Cons: the
router never chooses between cells; cross-account origins go untested.

### Option 2: Four cells, each with the full 100 agents
Pros: per-cell load matches the runtime-isolation runs. Cons: 400 Runtimes;
the longest deploy; account quotas on Runtime sessions and Lambda
concurrency are reached sooner for reasons the test is not about.

### Option 3: Four cells of 25 agents at `large`, two per account
Pros: routing across cells and accounts is tested; the Runtime count stays
at 100; deploy time stays about one cell's. Cons: per-cell load is a
quarter of a runtime-isolation run, so per-cell figures do not compare.

## Decision
Option 3, with the cell counts of spec §4.1: one cell at `small`, two at
`medium` (one per account), four at `large` (two per account), and the
tier's agents and tool targets divided across them. Results compare platform
totals with the runtime-isolation runs, never per-cell figures.

## Consequences
Easier: the front door's reason to exist is under load; per-account quotas
are spread across two accounts, and the budget (spec §4.4) shows by how
much. Harder: a per-cell bottleneck that shows only at 100 agents behind one
ingress is no longer reached; the runtime-isolation slice keeps that test.
Revisit if the front door gains per-cell weights, or if a cell shape other
than one runtime-isolation deployment is needed.
