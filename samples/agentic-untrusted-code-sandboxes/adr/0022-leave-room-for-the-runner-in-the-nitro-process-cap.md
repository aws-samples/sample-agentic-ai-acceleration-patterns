<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0022: Leave room for the runner in the nitro process cap

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR-0019, ADR-0021
- Amended by: ADR-0074
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

On `nitro`, ADR-0019 set each job process's `RLIMIT_AS` to L, and
ADR-0021 moved the watchdog to the task group's `memory.current`, which
also counts the runner. S-19 measured the runner at about 25 MiB of the
group at idle. A single process that filled 752 MiB, inside its own
limit, pushed the group past L, and the watchdog killed it instead of the
process getting `MemoryError`. S-19 also showed the watchdog is only an
early warning: the kernel's task limit sometimes acts first, and the
runner lived in all 85 fills either way.

## Options considered

### Option 1: Lower A to L less 64 MiB
Pros: a single process hits its own limit first and sees an error it can
handle, with room for the runner and kernel overhead. Cons: each job
process gets 64 MiB less address space.

### Option 2: Raise the watchdog threshold by the runner's share
Pros: keeps A at L. Cons: the threshold moves closer to the task limit,
which already leaves only 25 to 90 ms of a fast fill.

## Decision

Option 1 (spec §3.5 memory cap table). On `nitro` A = L − 64 MiB. The
watchdog stays at L as an early warning, on `memory.current` less the
file cache (`file` less `shmem`), so files written to `/work` do not
trigger it; the task limit is the cap. Both the 64 MiB margin and the
file-cache correction are checked in S-20. On `microvm` the floor stays
at 50 ms, now measured.

## Consequences

A process on `nitro` has 704 MiB of address space at the default task
size, and the tool description says so. A job of many processes is still
bounded by the watchdog and the task limit. Revisit if S-20 or the
integration test's `runaway` step shows a single process killed by the
watchdog, or if the runner grows.

Note 2026-11-20: S-20 measured both open items. With a probe runner
close to spec §3.5 the runner counted about 20 MiB, and a single process
at A = L less 64 MiB got `MemoryError` or `ENOMEM` with the watchdog
silent in 14 of 14 runs, 54 MiB below L. The margin holds while the real
runner's counted footprint stays within about 54 MiB above the probe's
20 MiB; measure it again with the real runner, and keep this ADR
Proposed until then. The file-cache correction held: jobs writing up to
2000 MiB to `/work` were never killed, while `memfd` and `/dev/shm`
pages still counted. The watchdog records `memoryExceeded` before it
sends the kill.

Note 2026-11-23: accepted. The integration test's `runaway` step runs the real runner on `nitro`: one process that allocates past its own address-space limit gets `MemoryError` with `memoryExceeded` false (the watchdog silent), and the next call on the same sandbox works. That passed in run 14, which is the S-20 check repeated with the real runner. The runner's own footprint was not measured separately.

Note 2026-11-23: amended by [ADR-0074](0074-lock-the-nitro-runner-in-memory-and-keep-the-watchdog-files-open.md). A fill from all 64 process slots stalled the runner, because the job held the task group at its limit and the kernel evicted the runner's code pages over and over. The runner now locks its pages, the task definition raises the `memlock` ulimit, the job's `RLIMIT_MEMLOCK` is 0, and the watchdog keeps its two files open. The watchdog's threshold and A are unchanged.
