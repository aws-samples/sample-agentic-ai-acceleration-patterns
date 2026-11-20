<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0021: Close the socket and SysV routes, watch the nitro group, and reap every job

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0019, ADR-0020
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

S-18 tested the ADR-0020 `microvm` setup in full and the SysV and
socket routes on `nitro` and `agentcore`.

- On `microvm`, two routes that need only descriptors stayed open: a
  Unix accept queue filled at 10 to 11 GiB/s, and a named Unix datagram
  receiver at 14 to 18 GiB/s. No poll catches that.
- The `microvm` guest is lost at about 2 to 7 MiB available, and only for
  memory no process maps. A 200 ms floor is certain only below about
  2.4 GiB/s; a 50 ms floor below about 9.5 GiB/s.
- On `nitro`, a SysV fill pinned the whole task limit in under 1 s, the
  objects outlived the job, and the runner died in 4 of 5 sweeps after a
  kill. The resident-memory watchdog saw none of it, and it read 827 MiB
  for a 64-process job whose group held about 140 MiB.
- On `agentcore`, the job group bounded SysV and socket memory, and the
  sweep freed leftovers in under 0.5 s.
- On every backend, the runner is PID 1 and did not reap orphans, so a
  killed job's zombies used up `RLIMIT_NPROC` for the next job.

## Options considered

### Option 1: Extend the filters, move the watchdog to the group, reap
Pros: each change closes one measured gap; S-18 ran the `microvm` socket
rules and the `nitro` SysV rule with no ordinary check broken. Cons:
jobs lose Unix sockets other than pairs and large listen backlogs on
`microvm`, and SysV IPC on `nitro`.

### Option 2: Rely on the floor and the sweep
Pros: no new filter entries. Cons: the socket routes outrun any poll,
and the `nitro` sweep killed the runner it was meant to protect.

## Decision

Option 1 (spec §3.5). The `microvm` filter also returns `EPERM` for
`socket(AF_UNIX)` and for `listen` with a backlog above 8, and its floor
polls every 50 ms. `nitro` gets a job filter returning `EPERM` for
`semget`, `msgget`, `shmget` and `shmat`, and its watchdog reads the
task group's `memory.current`. On both, the child also checks that one
blocked call returns `EPERM`, because `PR_GET_SECCOMP` proves only that
some filter is installed. `agentcore` gets no filter. On every backend
step 3 runs the SysV sweep after every job and then reaps with
`waitpid(-1, WNOHANG)`.

## Consequences

The tool description states the new limits. The `memory.current`
watchdog, the 50 ms floor against an unmapped fill and the `nitro`
filter's x32 entry are untested and planned in S-19. A floor that polls
20 times a second costs a little CPU, and a poll can still slip to
hundreds of milliseconds when every CPU is busy.
