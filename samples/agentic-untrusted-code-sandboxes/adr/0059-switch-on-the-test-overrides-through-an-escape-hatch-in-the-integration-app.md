<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0059: Switch on the test overrides through an escape hatch in the integration app

- Status: Accepted
- Date: 2026-11-20
- Amended by: ADR-0066
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Three steps need behaviour a real deployment must never offer: `max-life`
shortens a sandbox's life to 60 s through the reaper event, `failed-start`
makes one tenant's sandbox exit at boot, and `forged` calls the gateway tool
function directly. Threat T-88 names the risk: a switch that a vendor can
turn on lets a caller shorten lives or force failed starts. Mitigation M-60
says the variable is set only through a CDK escape hatch in the integration
stack and no prop exposes it.

## Options considered

### Option 1: A construct prop such as `testOverrides`
Pros: easy to wire and document. Cons: it is public API; a vendor can set it;
the guard becomes documentation.

### Option 2: A raw property override in the integration app, gated by an app context key
Pros: nothing in the construct changes or names the switch; the function that
sets it refuses to run unless the app carries `rcIntegTest` (set only by
`createIntegApp`), so copying the call into a deployment fails at synth.
Cons: the run-time code of the reaper and the tool reads two environment
variables that only tests set.

## Decision

Option 2. `test/integ/overrides.ts` writes `RC_INTEG_OVERRIDES=1` on the
`run-code` instance's reaper function, its gateway tool function and its
standalone function, and `RC_INTEG_FAIL_START_TENANT=E` on the two tool
functions. Without `RC_INTEG_OVERRIDES=1` the functions ignore the reaper
event's `maxLifeSeconds` and the failed-start tenant. The reaper's own
5-minute schedule is turned off in the same app, so a scheduled run never
lands inside a timing step (`idle`, `max-life`, `failed-start`).
A unit test (`test/integ/overrides.test.ts`) proves: the helper refuses an
app without the context key; the demo stack, with every backend and with the
context key set, has no function carrying the variable and no `RC_INTEG`
text in its template; no prop of the construct changes the resolved
settings; no CDK-side source file names the variable.

## Consequences

The owners of the tool, the backends and the reaper read the two variables in
their run-time code and nowhere else. Turning the reaper schedule off means
the integration stack does not test that the schedule fires; the schedule
rule is covered by the construct's synth tests. Revisit if a second test
needs another override: add it to `overrides.ts` and to the list in
`integration-test.md`, "Test-only shortcuts".

Note 2026-11-20: amended by ADR-0066. The guard is a mark in module state, not the context key `rcIntegTest`.
