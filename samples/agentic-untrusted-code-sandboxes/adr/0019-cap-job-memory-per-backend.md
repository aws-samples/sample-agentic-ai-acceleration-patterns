<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0019: Cap job memory per backend

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0010, ADR-0011, ADR-0016, ADR-0018
- Amended by: ADR-0020, ADR-0021
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.5, under ADR-0010, capped a job's memory with a cgroup v2 group
where the runner could create one, else a 200 ms watchdog, and relied on
the runner's `oom_score_adj` of -1000 and the job's 1000 so a kernel kill
took the job first. Spikes S-14 and S-15 (spec §7.3) measured each backend:

- No backend grants `CAP_SYS_RESOURCE`, so no runner can set -1000. The
  runner starts at 1000 on `microvm` and `agentcore` and at -998 on
  `nitro`.
- `microvm` has no cgroup mount and the runner cannot make one. Its guest
  is about four times `MinimumMemoryInMiB`. `RLIMIT_AS`, set with
  soft = hard before the drop to uid 1001, makes every allocation past
  the cap fail inside the job at once (0.09 to 0.13 s), and code cannot
  raise it.
  `RLIMIT_DATA` is bypassed by a shared `mmap`.
- `nitro` has a read-only cgroup mount, but the platform already caps
  the task group at the task size, and a kernel kill there took only
  jobs.
- `agentcore` lets the runner build a cgroup tree once it has moved
  itself out of the root. Its default `memory.oom.group` of 1 makes any
  out-of-memory kill end the whole session, runner included.

S-14 also answered the ADR-0018 checks. With management events only,
CloudTrail Event history holds no `RunMicrovm` and no
`InvokeAgentRuntime` event, and `RunTask` events hide the override
`environment`. The AgentCore container gets the session id header
unchanged. No path was found between two sessions of one runtime. The
AgentCore ready time of about 550 s that ADR-0016 left open recurred
without the DNS Firewall, so the firewall is not its cause; why S-9
saw about 200 s is still unknown. And an idle ECS managed instance
blocks the capacity provider delete until it scales in.

## Options considered

### Option 1: One mechanism per backend, chosen from what each allows
Pros: every backend gets a cap that was measured to hold; no capability
is added to any sandbox. Cons: three code paths in the runner, and on
`microvm` a per-process cap of 256 MiB with at most N processes, which
limits what a job can do.

### Option 2: Add capabilities to get one cgroup design everywhere
Pros: one code path. Cons: `nitro` would need `SYS_ADMIN` in the task
definition, which widens the sandbox for a limit the platform already
enforces; `microvm` offers no way to add a capability at all.

### Option 3: Keep the watchdog as the only cap
Pros: works on every backend. Cons: on `agentcore` a fill inside the
200 ms gap ends the session; on `microvm` the kernel picks victims by
size, so the runner is safe only while it stays small.

## Decision

Option 1 (spec §3.5 memory cap). Every backend sets `RLIMIT_AS` = A and
`RLIMIT_NPROC` = N with soft = hard before the uid drop, sets the job's
`oom_score_adj` to 1000, tries its own -1000 and ignores `EACCES`.
`microvm`: A = 256 MiB and N = ⌊0.7 × `MemTotal` / A⌋, so the rlimits are
the total cap. `nitro`: the platform's task limit plus the watchdog,
with `oom_kill` in the runner's scope as the record of a kernel kill.
`agentcore`: one job cgroup for the session's life with `memory.max` =
`MemAvailable` less 256 MiB and `memory.oom.group` = 1, after the runner
has moved into `/runner`, enabled `+memory` and written 0 to the root's
`memory.oom.group`. On every backend the job's `TMPDIR` is `/work/tmp`
and the runner deletes uid 1001's files under `/tmp` and `/dev/shm`
after each job; on `microvm`, where no group charges tmpfs pages, it
also makes both unwritable to uid 1001, which takes `multiprocessing`
locks, queues and pools from the job. Files in `/work` still outlive
a job; whether `/work` is tmpfs is checked in S-16. Once every task has
stopped, the drain deregisters the `nitro` instances with `force`, which
ends them, and waits until EC2 shows them `terminated` (ADR-0011).

ADR-0018 stands as written: its design did not depend on what
CloudTrail records. ADR-0016 keeps the firewall off by default for the
allow-list upkeep alone, since the firewall is ruled out as the cause of
the ready time.

## Consequences

A memory fill no longer depends on an `oom_score_adj` value on
`microvm` and `agentcore`. On `nitro` the watchdog, which fires at L
below the task limit, is the cover if the platform's -998 changes; it
does not see an unmapped `memfd` or tmpfs files, and it is untested
until S-16. `microvm` jobs are limited to 256 MiB per process and about
ten processes and threads at the default size, each thread taking about
8 MiB of stack out of the 256 MiB, which rules out runtimes that reserve
large address space, such as Node (344 MiB to start); the sample runs
Python only. A larger `microvm.memoryMiB` raises N, not A. The runner
needs unit tests for all three setups. `memoryExceeded` is never set on
`microvm`: the job sees the error itself. Open until S-16: whether
`/work` is tmpfs; an unmapped `memfd` or a tmpfs file filled during a
job, including against the `nitro` watchdog; the `agentcore` setup under
a global out-of-memory; and, for the drain, the time to `terminated`,
whether the capacity provider delete then succeeds, and whether a
`nitro.minInstances` above 0 starts a replacement first. Also open:
CloudTrail with data events. Revisit if `microvm` gains a cgroup mount, or if a
platform grants `CAP_SYS_RESOURCE`.

Note 2026-11-19: amended by ADR-0020. On `microvm` the rlimits do not count an unmapped `memfd`, socket buffers, SysV objects, `vmsplice` pages or a user-namespace tmpfs, and one of them ended the MicroVM (S-16). A seccomp filter in the job and a free-memory floor close that, and N drops to ⌊0.6 × `MemTotal` / A⌋ so the routes left open fit above the floor. S-16 also answered the open items: `/work` is disk on every backend, the drain ends instances in 17 to 30 s, and the capacity provider has no minimum, so `nitro.minInstances` is dropped.

Note 2026-11-20: amended by ADR-0021. The `nitro` watchdog reads the task group's `memory.current` instead of summing resident memory, and a `nitro` job filter blocks SysV IPC. `agentcore` needs no filter: its job group bounds SysV and socket memory (S-18).
