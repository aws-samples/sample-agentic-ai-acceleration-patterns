<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0074: Lock the `nitro` runner in memory and keep the watchdog's files open

- Status: Accepted
- Date: 2026-11-24
- Amends: [ADR-0022](0022-leave-room-for-the-runner-in-the-nitro-process-cap.md)
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

On `nitro` the runner and the job share one memory limit, the task
group's (ADR-0021, ADR-0022). A job that fills memory from every process
slot at once (the job and 63 children, each up to A) stalled the runner:
it wrote no `job_done` line within `runTimeout` + 5 s, the tool stopped
the task as an overrun, and the tenant lost `/work` (issue 144). The
cause was not known.

A demo stack with only the `nitro` backend, in a non-production test
account, reproduced it: 5 of 8 such fills overran, each after 35.1 s
(`runTimeout` 30 s + 5 s), and one more took 31.8 s. A side process in
the runner's task logged the task group twice a second. The task's VM
has 1 vCPU and about 1156 MiB; the task group's limit is 1024 MiB; there
is no swap. In each stall the group sat at 1015 to 1023 MiB, its page
cache fell from about 19 MiB to 3 MiB, and the group counted about 31,000
refaults of file pages, with memory pressure (PSI `full`) at 44 to 54 %.
The kernel killed 46 to 51 job processes one at a time, and the job's
other processes filled the freed memory again. The side process itself
wrote nothing for 33 to 43 s.

So the stall is page-cache thrashing at the limit. With no swap, the only
pages the kernel can reclaim are file pages, and the runner's code
(the interpreter, its libraries, the runner's modules) is among them.
The runner's pages were evicted and read back over and over, so the
watchdog (ADR-0022) and the HTTP thread barely ran. The kernel's
out-of-memory killer acted only about once a second, because evicting a
file page counts as progress, and the job's other processes filled what
each kill freed.

## Options considered

### Option 1: Lock the runner's pages (`mlockall`)
Pros: the runner's code and data stay in memory, so the job's fill
cannot evict them; with nothing left to reclaim, the kernel kills job
processes at once. The job does not inherit the lock. Cons: the task
definition must raise the `memlock` ulimit, and the job must get it back
to 0. With the lock alone, a fill still took 1.2 to 23.7 s (14 fills):
the watchdog opened its two cgroup files on every poll, and those reads
waited 6 to 19 s, because an open allocates and every allocation in the
full group waits.

### Option 2: A job cgroup under the task group, as on `agentcore`
Pros: the job's limit would no longer be the runner's. Cons: the cgroup
mount is read-only on `nitro` and the task definition adds no capability
(S-14, ADR-0046), so the runner cannot create one.

### Option 3: A lower total for the job (smaller A or N)
Pros: no change to the task. Cons: 64 processes at A = L − 64 MiB are
far above the limit; a total cap needs a cgroup (Option 2). Shrinking A
or N enough would break ordinary jobs.

## Decision

Option 1, with the watchdog's files kept open:

1. On `nitro` the runner calls `mlockall(MCL_CURRENT)` once it is
   claimed and its TLS context is made, then
   `mlockall(MCL_FUTURE | MCL_ONFAULT)`, so later mappings (thread
   stacks, modules loaded later) are locked page by page as they are
   touched and nothing is filled in ahead. If the kernel refuses, the
   runner logs `start_failed` and the task ends, like any other failed
   start.
2. The task definition sets the container's `memlock` ulimit to
   unlimited (soft and hard -1). It is a ulimit, not a capability: the
   container still adds none (`LinuxParameters` stays unset). The runner's
   locked size counts whole mappings, about 100 to 375 MiB of address
   space, while only its resident pages (about 36 MiB) use memory; a fixed
   bound could refuse a later mapping and break the runner.
3. Every job child sets `RLIMIT_MEMLOCK` to 0 (soft and hard) before it
   drops to uid 1001, on every backend, so code can lock nothing.
4. The `nitro` watchdog opens `memory.current` and `memory.stat` once,
   keeps them open for the task's life, and reads them with `pread`. The
   decision of ADR-0022 (the watchdog at L on `memory.current` less the
   file cache, A = L − 64 MiB) is unchanged.

Measured on the same stack: with the lock and the open files, 0 of 44
such fills overran (32 with the side process, 14 of them with one of
the two variants below; 12 without). All 12 fills
of the final runner answered `memoryExceeded` true in 0.65 to 7.4 s,
kept the `bootId`, and kept every file the tenant had written to
`/work` before them. Locking cost about 0.3 MiB of the group at idle
(25.7 against 25.5 MiB in a local container).

Two other changes were tried and not kept: ending the job on the first
`oom_kill` in `memory.events` before reading `memory.stat`, and running
the job at nice 19. Neither shortened the fills measurably.

## Consequences

The `runaway` step requires `memoryExceeded` on `nitro` again; a tool
overrun there is a failure. A fill from every slot still takes up to
about 7 s on a 1 vCPU task, because the runner's own allocations wait
while the group is full; the slowest seen is well inside a 20 s
`runTimeout`. The runner's locked memory comes out of the 256 MiB margin
between L and the task limit, as its resident memory already did.

Revisit if the runner grows past the margin, if a fill again ends as an
overrun, or if the platform offers a writable cgroup for the job
(Option 2).
