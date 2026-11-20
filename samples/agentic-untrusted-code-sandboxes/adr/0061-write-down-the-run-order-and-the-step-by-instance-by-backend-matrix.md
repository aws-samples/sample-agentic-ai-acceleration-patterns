<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0061: Write down the run order and the step by instance by backend matrix

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §8 lists the steps in a table whose order is not the order they can
run in (`microvm-stop`, `idle` and `cold-from-zero` wait on clocks and on one
another; `offboard` removes what `race` creates; `synth` and
`standalone-build` need no stack). It says every behaviour step runs once per
backend unless it names one, but several steps name backends inconsistently,
and the second instance has only `agentcore`.

## Options considered

### Option 1: Run in table order and let steps wait for each other
Pros: the table and the code read side by side. Cons: a 2-minute idle wait
three times in a row, and `cold-from-zero` before `idle` cannot start from zero.

### Option 2: A written run order and matrix, checked by a unit test
Pros: waits overlap with other work; the order is data (`test/integ/steps.ts`)
with the dependency of each step named, and a test fails when a step runs
before one it needs. Cons: the document carries two orders.

## Decision

Option 2. `integration-test.md` lists the steps in run order and says how
the table order differs. The matrix: per-backend steps run once on each
backend the step names, on `run-code` (which has all three), except `dns` and
`teardown`, which also run on `run-code-files` (firewall off; its runtime);
`session-files` runs on `run-code-files` only. A step that names no backend
(`seed`, `iam-wall`, `forged`, `offboard`, `synth`, `standalone-build`,
`dns-platform`) runs once; `offboard` covers all three backends itself, because
tenant `C` holds a sandbox on each. `prefix`, `limits`, `no-credentials`, `no-egress`, `runaway`,
`dead-handle`, `race`, `telemetry` and `parse`/`reuse`/`apart` run
on all three because the spec states per-backend conditions for them or none
at all. `standalone` runs its parse call per backend and its refusals once.
The two failed-start backends are `nitro` and `microvm`, as the spec says.

## Consequences

A reader who wants a step's backends reads `steps.ts` or the matrix in
`integration-test.md`. A new step is added in one place and the unit test
checks the spec table, the run order and the implementations agree.
