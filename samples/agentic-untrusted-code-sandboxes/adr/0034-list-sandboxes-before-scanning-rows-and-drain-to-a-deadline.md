<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0034: List sandboxes before scanning rows, and drain to a deadline

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The reaper (ADR-0011) must stop a sandbox no row names without stopping one
whose row is only about to name it, because a start writes the row, calls the
platform, then records the handle. The drain (spec §5.3) must end every
sandbox before the stack deletes the cluster, the runtime and the image, and
must say so when it cannot, because CloudFormation does not retry a failed
capacity provider delete. Neither the spec nor ADR-0011 fixes the order of
the reads, the guard for a start in flight, or what the drain returns to the
custom resource framework.

## Options considered

### Option 1: scan rows, then list sandboxes
Pros: the natural order. Cons: a sandbox started after the scan and before
the list has no row in the scan, so it looks like an orphan and is stopped
while its tool is still starting it.

### Option 2: list sandboxes, then scan rows, and skip sandboxes of a start in flight
Pros: a sandbox that exists when the scan begins has a row with its handle
or a handle-less `STARTING` row, which the guard recognises. Cons: a real
orphan inside a start's window waits one more pass (five minutes).

## Decision

Option 2.

The reaper lists each backend, scans every row, and handles each row by
state. Before any stop it writes `STOPPING` with the version it saw, so a call
that updated the row meanwhile wins and the reaper leaves that row to it.

| Row | Reaper does |
|---|---|
| expired, or its task's own `startedAt` older than `sandboxMaxLife` | `STOPPING`, stop, line, delete; a handle-less row is only deleted |
| `FAILED` or `STOPPING` | stop again only a sandbox the platform still lists, with no new line; delete once expired |
| `READY`, `nitro`, idle past `sandboxIdle` | `STOPPING`, stop, line |
| `READY`, sandbox gone (`isAlive` false) | conditional delete, then the line |
| `STARTING` with a handle, ended or past its lease | `FAILED` with a 30 s backoff, stop, line, as the tool does |
| `STARTING` with a handle, otherwise | left alone |
| `STARTING`, no handle, younger than `startWait` plus the tool timeout | left alone, and it shields unlabelled sandboxes of its backend (`microvm`) or its tenant's (`nitro`) from the sweep |

A listed live sandbox that no row names, and that no such shield covers, is
stopped and gets an `orphan` line. `agentcore` lists nothing. A row that
throws is counted, the pass finishes the others, and the pass fails at the
end so the error shows in the function's metrics. A second pass over the same
state stops nothing and writes no second line.

The drain is the `onEvent` handler of a custom resource provider. Create and
Update return the physical resource id and do nothing. Delete stops every
handle in the registry (a line each for rows it moved), then lists and stops
every live sandbox until none is live, stopping one again after a minute if it
is still listed, then runs each backend's `cleanup(deadline)`. The bound is
ten minutes or the function's remaining time less 30 s, whichever is sooner.
At the bound with a sandbox live it throws, which fails the resource and the
stack delete, and it never runs cleanup. A registry table that is already
gone counts as no rows.

## Consequences

The drain must be deleted before the table, the cluster, the runtime and the
image (`BackendConstruct.drainOrder`), and the construct wires it as the
`onEvent` handler of a custom resource provider, with a function timeout that
covers the ten-minute bound plus the backend cleanup. A drain that fails leaves the sandboxes it could not end for the
operator to remove, and its error names how many.
