<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0008: Split the k6 library, mirror the repository on the host, and write the record from handleSummary

- Status: Accepted
- Date: 2026-11-19
- Deciders: Dave Roberts (PSA)

## Context
ADR-0007 moves the k6 library to `stress/k6/`. The runtime-isolation `lib.js`
mixes what every slice needs (tier, manifest, identity tokens, pacing,
counters) with what only that sample knows (the `/invocations` call, the
session prefix, the report and tool assertions). Three things need a
decision: where the line falls, how a scenario in a sample reaches a library
in another folder once both sit on the driver host, and how a scenario writes
the record of `src/result.ts` when k6 has no per-VU end hook and no way to
hand per-tenant data to `handleSummary`.

## Options considered
### Option 1: One generic library; the sample keeps its probes in `probe.js`
Pros: slices import one tested core and add only their calls. Cons: the
shared state (`vu`, pacing) is exported, which couples `probe.js` to the
library's internals.
### Option 2: Move `lib.js` whole
Pros: no split. Cons: the next slice imports a file that asserts on another
sample's report fields.
### Option 3: A library of hooks the slice registers
Pros: no exported state. Cons: indirection for a library with one consumer today.

For reaching the library from a sample: (a) a bundler step that inlines the
imports (a build step per scenario); (b) copying `stress/k6/` into the sample's
folder (two copies); (c) mirroring the repository paths on the host, so
`import ... from '../../../../../stress/k6/lib.js'` is valid in a checkout and
on the host.

For the record: (x) log JSON lines and have `collect` build every record;
(y) build the record in `handleSummary` from k6's own metrics.

## Decision
Option 1, (c) and (y).
- `stress/k6/lib.js` holds the generic core; `samples/<name>/scripts/stress/k6/probe.js`
  holds the sample's calls and assertions, and re-exports what its scenarios use.
- `stress/driver/k6.sh` copies `stress/k6/` and the script's folder to
  `/opt/stress/repo/` at the same relative paths, and runs `k6` in the script's
  folder. A slice's own `run.sh` may do the same through S3; the layout is the contract.
- `summarize(data, { slice, scenario })` builds the record in `record.js`, a
  file with no k6 import, so jest runs it and checks `parseRecord` accepts it.
  Requests, the `client` and `client-ttfb` hops, and the isolation counts come
  from k6 metrics. `refusals.unattributed` is the number of 4xx and 5xx the
  driver saw and `byTenantReason` is empty: attributing a refusal to a tenant
  needs the hops' logs, which is the slice's `collect` (spec §3.4, P-7). A
  scenario that is refused and never collected fails the run, as P-7 asks.
- Every request the library makes carries `x-correlation-id` (ADR-0005), and
  the mismatch lines on stderr carry it.
- No record is written without `STRESS_RESULTS`, so a scenario run by hand
  still works; with it, a missing `STRESS_*` variable fails the scenario.

## Consequences
Easier: a slice writes a probe module and scenario files; the record is the
same everywhere and tested. Harder: a sample's scenario depth in the tree
(five `..`) is part of the contract; `probe.js` reads the library's `vu`
state. k6 reads `jslib.k6.io` at start, so the host needs that egress, which
it has. ADR-0007 expects history to follow a `git mv`; `lib.js` changed too much for git
to see a rename, so its history before W-2 is under the old path
(`git log origin/main -- samples/agentic-runtime-isolation/scripts/stress/k6/lib.js`).
Revisit if a second slice needs warm-up or step logic that differs from `probe.js`: those two would then move into the library behind hooks (Option 3).
