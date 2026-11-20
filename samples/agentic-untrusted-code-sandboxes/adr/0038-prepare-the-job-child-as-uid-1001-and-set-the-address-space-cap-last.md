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
a fork of the runner until `exec`, and the runner's address space (thread
stacks, allocator arenas) can be larger than A: on the AL2023 Python 3.9
image, with `RLIMIT_AS` set before the remaining steps of the child, the
child crashed with `SIGSEGV` before `exec`, which the runner would have
reported as the code's own exit code.

## Options considered

### Option 1: Every limit before the drop, as the spec words it
Pros: the literal order. Cons: any allocation after `RLIMIT_AS` in the
forked child can fail, and a crash there looks like tenant data.

### Option 2: `RLIMIT_AS` last, after the drop and the filter
Pros: the child holds the cap from `exec` on, soft = hard, and uid 1001
without `CAP_SYS_RESOURCE` cannot raise it, which is what the spec's
order protects. Cons: one limit is set after the drop.

## Decision

Option 2. The job child, between `fork` and `exec`:

1. writes 1000 to its `oom_score_adj`, and on `agentcore` moves itself into
   the job group;
2. sets `RLIMIT_CPU`, `RLIMIT_NPROC`, `RLIMIT_FSIZE` and `RLIMIT_NOFILE`,
   soft = hard;
3. drops to uid and gid 1001 with no supplementary groups, umask 077;
4. writes the input as uid 1001: it removes `/work/input` (a directory
   there is renamed aside), creates it with `O_EXCL | O_NOFOLLOW`, and
   makes `/work/tmp` if missing. A link left in `/work` cannot redirect a
   root write. An absent input is an empty file, as it is in `jobAuth`;
5. on `microvm` and `nitro` installs the filter and proves it
   (`PR_GET_SECCOMP` = 2 and the blocked call answers `EPERM`);
6. sets `RLIMIT_AS` = A, soft = hard.

A failure in any step raises through `subprocess`'s error pipe before
tenant code runs, and the runner answers `tool_failed`. The code reaches
`python3 -I -S -` on its standard input, so a NUL byte in it is the code's
own `SyntaxError`, and the command line stays short.

After every job, a sweep that cannot clear uid 1001 within 5 s marks the
runner `dirty` on every backend, not only on `agentcore`, so the tool takes
over instead of running the next job beside a survivor. The runner sets
itself as a child subreaper, so orphans of a job come back to it to be
reaped even where it is not PID 1. The `microvm` floor and the `nitro`
watchdog poll only while a job runs: no uid 1001 process exists between
jobs.

## Consequences

The Docker test checks every limit from inside a job, on Python 3.13 and
3.9. The lowest free descriptor in the child must stay below
`RLIMIT_NOFILE` (64 on `microvm`) for step 4; the runner keeps one
connection per call, so it does.
