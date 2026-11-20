<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0018: Order the platform set-up in the runner, with slice steps

- Status: Proposed
- Date: 2026-11-21
- Deciders: Dave Roberts (PSA)

## Context
"Spec" below means
[`docs/stress-test.spec.md`](../../docs/stress-test.spec.md).

A platform run composes four slices whose set-up depends on each other in a
cycle if each slice is read as one `deploy` and one `seed` (spec §3.5): the
front door's first deploy needs the control plane's API; the control plane's
stress application needs the front door's distribution as a cell parameter;
the cell that application builds needs the front door's route hook, which in
turn needs the control plane's hook policy; and the front door's second phase
needs the cell's ingress. The runner of W-1 ran `deploy` and then `seed` of one
slice before the next. Teardown has one ordering rule too: the control plane
must stop calling the front door's registrar before the registrar goes (spec
§3.5).

## Options considered
### Option 1: Split every slice into the verbs the order needs
Each slice gets more verbs (`deploy-1`, `deploy-2`, and so on), and each verb is
ordered by `needs`. Pros: no runner table. Cons: a verb name that means
"the second half of my deploy after another slice did something" is the
runner's order written into every sample; `needs` cannot express two slices
that each need the other half-way.

### Option 2: One `step <name>` verb, and the order in the runner
`slice.json` lists the steps a slice implements (`steps`), `slice.sh step
<name>` runs one, and the runner holds the platform order as a table
(`stress/src/platform.ts`) that names the slice and the verb or step of each
action. The runner refuses a table entry for a step the slice does not list.
Pros: the order is one reviewable table; a sample declares what it can do and
nothing about when; a platform run with fewer slices skips the entries of the
slices that are not in it. Cons: the runner names samples (`control-plane`,
`tenant-front-door`), which the contract has avoided so far.

### Option 3: A shell script outside the runner that calls the slices
Pros: no runner change. Cons: no budget check, no result records, no teardown
on failure or signal: everything the runner is for.

## Decision
Option 2. The table is the platform run's order of spec §3.5: identity, control
plane, front-door phase one, the control plane's `hooks`, `register` and
`warm-up` steps, the front door's `phase-two` step, then the runtime-isolation
slice. A step runs in platform mode only. A step before a teardown (the control
plane's `unhook`, before the front door's `teardown`) is a second table. A
slice's deploy seconds are the time of its `deploy` and its steps, which is the
time it needs to be ready to run (P-6); its `seed` is not part of it.

## Consequences
Easier: the order that took a paragraph and a table in the spec is code with a
test; the control plane and the front door each implement steps that read like
the spec's table.

Harder: the runner knows the names of two samples. A fifth slice that joins the
platform run adds its entries to the table. A slice-mode run is unchanged.

Revisit if more than two slices need steps, or if the order has to differ per
tier.
