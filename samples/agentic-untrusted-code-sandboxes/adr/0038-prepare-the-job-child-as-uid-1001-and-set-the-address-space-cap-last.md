<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0038: Prepare the job child as uid 1001, and set the address space cap last

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.5 steps 1 and 2 write the input to `/work/input`, then start
`python3 -I -S` on the code as uid 1001 with limits set, soft = hard,
before the drop to uid 1001. `/work` belongs to uid 1001, and files there
outlive a job, so a job can leave a link at `/work/input`. The job child is
a fork of the runner until `exec`. The runner can hold more address space
(thread stacks, allocator arenas) and more descriptors than the job may:
with `RLIMIT_AS` set before the remaining steps, any allocation in the
child can fail, and on the AL2023 Python 3.9 image the child can crash
with `SIGSEGV` before `exec`, which the runner would report as the code's
own exit code. `RLIMIT_CPU` = `runTimeout` counts from the fork, before the
runner's wall timer starts, so a CPU-bound job often ends by the kernel's
`SIGKILL` at the hard limit rather than by the wall timer.

## Options considered

### Option 1: Every limit before the drop, as spec §3.5 words it
Pros: the literal order. Cons: an allocation or a descriptor in the
forked child can fail, and a crash there looks like tenant data.

### Option 2: `RLIMIT_NOFILE` and `RLIMIT_AS` last, after the drop and the filter
Pros: the child holds both caps from `exec` on, soft = hard, and uid 1001
without `CAP_SYS_RESOURCE` cannot raise them, which is what the spec's
order protects. Cons: two limits are set after the drop. This ordering
refines spec §3.5 step 2; this record is where the difference is written.

## Decision

Option 2. The job child, between `fork` and `exec`:

1. writes 1000 to its `oom_score_adj`, and on `agentcore` moves itself into
   the job group;
2. sets `RLIMIT_CPU`, `RLIMIT_NPROC` and `RLIMIT_FSIZE`, soft = hard;
3. drops to uid and gid 1001 with no supplementary groups, umask 077, and
   sets `PR_SET_NO_NEW_PRIVS` on every backend, so no setuid binary of
   the image gives the job root back;
4. writes the input as uid 1001: it removes `/work/input` (a directory
   there is renamed aside), creates it with `O_EXCL | O_NOFOLLOW`, and
   makes `/work/tmp` if missing. A link left in `/work` cannot redirect a
   root write. An absent input is an empty file, as it is in `jobAuth`;
5. on `microvm` and `nitro` installs the filter and proves it
   (`PR_GET_SECCOMP` = 2 and the blocked call answers `EPERM`);
6. sets `RLIMIT_NOFILE` and `RLIMIT_AS` = A, soft = hard.

A failure in any step raises through `subprocess`'s error pipe before
tenant code runs, and the runner answers `tool_failed`. The code reaches
`python3 -I -S -` on its standard input, so a NUL byte in it is the code's
own `SyntaxError`, and the command line stays short.

A job ended by `SIGKILL` or `SIGXCPU`, with `memoryExceeded` false, at
`timeoutMs` less 100 ms or later, is reported `timedOut`: that is
`RLIMIT_CPU` acting at `runTimeout`.

A runner fault after the job started (a thread that does not start, for
example) kills the job's process group, sweeps, and answers `tool_failed`.
After every job, a sweep that cannot clear uid 1001 within 5 s, or cannot
walk `/tmp` and `/dev/shm` within one further 5 s, marks the runner
`dirty` on every backend,
not only on `agentcore`, so the tool takes over instead of running the
next job beside a survivor. So does a fault whose sweep result is unknown.
The runner sets itself as a child subreaper, so orphans of a job come back
to it to be reaped even where it is not PID 1. The `microvm` floor and the
`nitro` watchdog poll only while a job runs: no uid 1001 process exists
between jobs.

## Consequences

The Docker test checks every limit from inside a job, on Python 3.13 and
3.9, and `NoNewPrivs` on every backend. The child still runs Python code
between `fork` and `exec` in a threaded process; it is kept to system calls
and objects prepared before the fork. A single-threaded helper that execs
the job would remove that hazard and is the upgrade path if it ever shows.
