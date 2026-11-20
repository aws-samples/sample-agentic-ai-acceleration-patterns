<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0035: Offboard by row, and keep a row whose stop failed

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §5.2 says `offboardTenant` sets each of the tenant's rows `STOPPING`
with a version condition, stops the sandbox, deletes the row, and returns the
stopped handles, as the reaper role. It does not say what happens when the
stop call fails, when a call updates the row meanwhile, or whether it also
looks for sandboxes no row names.

## Options considered

### Option 1: delete the row whatever the stop said
Pros: the tenant's rows are gone. Cons: a sandbox that is still live is then
an orphan with no tenant, and the caller believes the tenant is clean.

### Option 2: keep the row `STOPPING` and fail the call when a stop failed
Pros: the reaper stops a `STOPPING` row's live sandbox again (ADR-0034), the
caller learns, and the tenant stays attributable. Cons: the caller must
retry.

### Option 3: also list sandboxes by tenant tag
Pros: catches a `nitro` task whose row is gone. Cons: one more list call per
offboard, and a race with a start in flight that the sweep already handles.

## Decision

Option 2, and not Option 3. For each enabled backend the function reads the
tenant's row. A `READY` or `STARTING` row with a handle is set `STOPPING`
with the version read (a lost race means read again, up to four times),
stopped, lined (`by` = `offboard`), and deleted at the version it wrote. A
`FAILED` or `STOPPING` row has its line already: its sandbox is stopped again
only if `isAlive`, and the row is deleted. A row with no handle is deleted.
It never touches another tenant's key, which `TENANT#<id>` makes exact, so
`tenant-a` does not reach `tenant-a2`.

A sandbox that is still listed after a successful stop (a `nitro` task stays listed
while it stops) keeps its `STOPPING` row, so the reaper does not take it for an
orphan and line it again; the reaper deletes the row once the sandbox has left
the list; a `FAILED` row is moved to `STOPPING` for that. The call still returns it
in `stopped`. A sandbox a takeover replaced and that is still named on the row is
stopped too. Its line is the one the call that took the row over writes; when that
call died first (`replacesLined` false and the row older than a tool call's timeout,
after which no live call can still be writing it), the offboard claims and writes it,
because it deletes the row and nobody else could. A row younger than that has its
sandbox stopped and no line from the offboard, which leaves the line to the call;
if that call died in the first minute, the sandbox has none. A replaced sandbox whose
stop fails keeps the row and fails the call. A takeover of a `FAILED` or `STOPPING`
row writes `replacesLined` true at once, because those rows already had their line. A call that finds its row gone after its
takeover returns `sandbox_starting` and starts nothing.

A stop that fails keeps the row, finishes the other backends, and throws, so
the control plane's tenant delete script stops. A second call repeats the
stop. Each stopped handle is listed once. A tenant id that breaks the §5.1 rule throws before any client is
built. A call finds no rows on a repeat and returns `{ tenantId, stopped: [] }`.
The stopped list holds only sandboxes this call stopped.

## Consequences

A row that keeps changing is given up on after four reads without a stop,
and that counts as a failure: the call throws, and the caller repeats it
(the call is idempotent). The caller removes the `run_code` grant first
(spec §5.2), which stops the changes. An orphan with no row is the reaper's.
