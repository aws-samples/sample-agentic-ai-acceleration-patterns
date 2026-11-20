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
| `STARTING` with a handle, sandbox ended, or its lease run out | `FAILED` with a 30 s backoff, stop, line, as the tool does; a start whose lease ran out is stopped even if it became ready, because nobody came back for it, and a ready `nitro` task would otherwise run to `sandboxMaxLife` |
| `STARTING` with a handle, otherwise | left alone |
| `STARTING`, no handle, younger than `startWait` plus the tool timeout | left alone, and it shields sandboxes started after that row was written, of its backend (`microvm`) or its tenant's (`nitro`), from the sweep |

The reaper does not call `ready`. That probe is the tool's: on `microvm` it
needs an auth token the reaper role does not hold, and on `nitro` a TLS
connection the reaper has no network path for. The reaper answers "ended?"
with `isAlive` and the reason with `stopReason`.

A listed live sandbox that no row names, and that no such shield covers, is
stopped and then gets an `orphan` line; a stop that fails writes no line and
is tried again on the next pass, so an orphan has one line however many
passes it takes. A row whose stop fails stays `STOPPING` (also when expired)
and is stopped again while the platform lists its sandbox.
A takeover that replaces a sandbox writes the replaced handle on the new row
(`replaces`) and keeps it there, so the old sandbox, which a `nitro` stop keeps
listed for a minute, is neither an orphan nor lined twice; the reaper and the
drain stop it again if it is still listed. The call that took the row over stops
the old sandbox, writes its line, and then sets `replacesLined` on the row. A row
that is older than `startWait` plus the tool timeout with `replacesLined` still
false means the call died first: the reaper or the drain claims the line with a
conditional write of `replacesLined`, stops the sandbox, and writes the line
(`reason` = `replaced`), once. A `replaces` equal to the row's own handle, or
listed for another tenant, is ignored. `offboardTenant` stops it too. A stop that
fails for the whole life of the next sandbox, and a second takeover in that time,
can give the old handle a second line; that case is accepted. A list that failed says nothing about
a sandbox, so a row is not treated as gone because it was not listed.
The shield uses the platform's `startedAt` against the row's `createdAt`
(with 5 s of clock slack), so a real orphan is not shielded for as long as
new starts keep arriving. `agentcore` lists nothing. A row that
throws is counted, the pass finishes the others, and the pass fails at the
end so the error shows in the function's metrics. A second pass over the same
state stops nothing and writes no second line.

The drain is the `onEvent` handler of a custom resource provider. Create and
Update return the physical resource id and do nothing. Delete stops every
handle in the registry (a line each for rows it moved), then lists and stops
every live sandbox until none is live, stopping one again after a minute if it
is still listed, then runs each backend's `cleanup(deadline)`. A row a call
updates while the drain moves it is read again (four times); a row that keeps
changing is stopped anyway and the drain writes its line. The wait and the
cleanup each have a bound of ten minutes, both cut to the function's remaining
time less 30 s.
At the bound with a sandbox live it throws, which fails the resource and the
stack delete, and it never runs cleanup. A registry table that is already
gone counts as no rows.

## Consequences

The drain must be deleted before the table, the cluster, the runtime and the
image (`BackendConstruct.drainOrder`), and the construct wires it as the
`onEvent` handler of a custom resource provider. A Lambda is capped at 15
minutes, so the function timeout is that cap: the wait and the cleanup share
it, each cut to the time left. A start in flight when the drain runs (a handle-less `STARTING` row the drain
skips) can produce a second line for its sandbox: an `orphan` line from the
drain's sweep and a `failed_start` line from the tool call that finds it
stopped. The window is one start, and the integration test's teardown has
no calls in flight. A drain that fails leaves the sandboxes it could not end for the
operator to remove, and its error names how many.

A `STOPPING` row is deleted by the reaper, with no line, when its sandbox has left
the list, `isAlive` agrees, and the sandbox it replaced has left the list too; a
`FAILED` row stays for its backoff. That is how a row an offboard kept for a task
that was still stopping goes away. `agentcore` lists nothing and is always
alive, so its `STOPPING` row waits for expiry, and the next call's takeover stops
the session again if a stop failed.

Two windows of one network call each give a replaced sandbox two lines or none:
a Lambda killed between the line and the `replacesLined` write (two), and one
killed inside the line write before it reaches the log, with the next takeover
dropping `replaces` first (none). Closing them needs a two-phase write; they are
accepted.

What a backend owes this logic: `stop` does not throw for a sandbox that is
already gone; a `nitro` task in its stopping states counts as live in `list()`
(spec §5.3), and the sample keeps a row for it so it is not taken for an orphan;
and `ready` answers within the budget of a probe, because a dead handle
that takes long to detect leaves the tool call too little time for a new start.
