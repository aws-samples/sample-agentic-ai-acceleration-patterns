<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0001: Keep the shared stress contract in a root `stress/` folder

- Status: Accepted
- Date: 2026-11-18
- Deciders: Dave Roberts (PSA)

## Context
The platform stress test (`docs/stress-test.spec.md`) composes four samples
and needs code that belongs to none of them: the tiers, the k6 library, the
result schema, the quota budget, the runner, the driver host and the stress
application. The sample standard (§1) lays out `samples/<name>/` only and
has no place for code shared across samples. Each sample also keeps its own
part of the test, its slice (spec §3.4), so it can run alone.

## Options considered
### Option 1: A root `stress/` folder, with its own `adr/`
Pros: one owner for the contract; slices stay in their samples; the
standard's per-sample layout is untouched. Cons: a second kind of top-level
folder; the folder needs its own build and its own ADR index.

### Option 2: A test-only sample, `samples/platform-stress`
Pros: fits the existing layout. Cons: it is not a pattern a reader deploys,
so the sample standard's README, construct and integration-test rules do not
fit it; the root README would list it beside real samples.

### Option 3: Keep the contract inside `agentic-runtime-isolation` and import it
Pros: the code is already there. Cons: other samples would import another
sample's `scripts/` and `test/`, which the standard (§1.1) forbids; the
runtime-isolation sample would own the platform test.

## Decision
Option 1. `stress/` holds `tiers.ts`, the k6 library, the result schema,
the budget, the runner (`run.sh`), the driver host (`driver/`), the stress
application (`application/`), spikes (`spikes/`), results (`results/`) and
this ADR folder. Each sample's slice is `scripts/stress/slice.sh` and
`scripts/stress/slice.json` in the sample. A slice reads the contract from
`stress/` by path; it never reads another sample's files.

## Consequences
Easier: one contract many branches can build against at once; the platform
run has one home. Harder: the sample standard gains a section for `stress/`
(layout, build, what may live there), and `CONTRIBUTING.md` points to it.
Revisit if a second cross-sample asset appears that is not a test: then a
general root folder for shared code may fit better than `stress/`.
