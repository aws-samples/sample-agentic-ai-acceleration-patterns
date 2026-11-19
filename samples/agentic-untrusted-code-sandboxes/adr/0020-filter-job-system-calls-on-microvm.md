<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0020: Filter job system calls on microvm, and back the caps with a free-memory floor

- Status: Proposed
- Date: 2026-11-19
- Amends: ADR-0011, ADR-0019
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0019 capped `microvm` jobs with `RLIMIT_AS` and `RLIMIT_NPROC`,
because the guest has no cgroup the runner can use. S-16 found that the
rlimits do not count data in an unmapped `memfd`: a job with 9 MB of
resident memory, aiming at 3840 MiB, ended the MicroVM at about 3.6 GiB,
1.3 to 1.7 s in, with no result, in 3 of 3 runs. The kernel most likely
killed the runner; the guest has no kernel log. S-17 found
five more routes the rlimits miss: Unix socket buffers, SysV semaphores
and message queues, `vmsplice` pages held in pipes, and a tmpfs mounted
in a user namespace. Two of them stopped the runner the same way. SysV
objects outlive the job, and the root runner cannot remove them. The
guest's `/proc/sys` is read-only, so the kernel's own limits cannot be
lowered. The runner holds no capability, but `PR_SET_NO_NEW_PRIVS` lets
an unprivileged process install a seccomp filter.

S-16 also answered the open drain question. A forced deregister ends an
ECS managed instance in 17 to 30 s, no replacement starts, and the stack
delete then succeeds first time. The capacity provider has no
minimum-instances setting, so `nitro.minInstances` had nothing behind
it.

## Options considered

### Option 1: A seccomp filter in the job, plus a free-memory floor
Pros: closes every route S-17 found, with `EPERM` the job can handle;
installs with no capability and no library; costs about 0.16 ms per job
and 22 ns per system call; broke none of 20 ordinary job checks. Cons:
a list of exceptions, so a route nobody found stays open; the floor is
the only cover for that, and a 200 ms poll can lose to a fast fill.

### Option 2: A watchdog on `Shmem` or `MemAvailable` only
Pros: no list to keep. Cons: a `memfd` fill runs at about 4.5 GiB/s, so a
200 ms poll can overshoot by about 900 MiB on a 3998 MiB guest; `Shmem`
does not see socket, SysV or `vmsplice` memory at all.

### Option 3: One job per MicroVM, accept the loss
Pros: nothing new to build. Cons: the tenant loses its sandbox, files
and `bootId` with no cause code, from 20 lines of Python.

## Decision

Option 1 (spec §3.5 job filter). On `microvm` the runner sets
`PR_SET_NO_NEW_PRIVS` and installs the filter in each job after the uid
drop, checks `PR_GET_SECCOMP` = 2 in the child before `exec` and raises
through `subprocess`'s error pipe if not, so no code runs unfiltered and
the call returns `tool_failed`, lowers N to ⌊0.6 × `MemTotal` / 256 MiB⌋
(9 at the default) so the routes left open fit above the floor, also blocks new namespaces through `clone` and
`clone3`, sets `RLIMIT_NOFILE` to 64, and keeps a `MemAvailable` floor
of 512 MiB checked every 200 ms that kills the job and sweeps uid 1001.
`/tmp` is disk (S-16), so ADR-0019's lock on it is dropped; `/dev/shm`
stays closed. On every backend step 3 also removes uid 1001's SysV
objects through a uid 1001 child, because they outlive the job and the
root runner may not remove them (S-17).
`nitro` and `agentcore` otherwise keep ADR-0019: their task and job
groups bound the `memfd` and tmpfs routes (S-16). `nitro.minInstances` is
dropped, and the drain stays as ADR-0011's note describes.

## Consequences

`microvm` jobs lose `memfd_create`, SysV IPC, mounts, `unshare`, `setns`,
new namespaces through `clone`, `vmsplice` and socket buffer sizing,
have at most 64 open files per process and nine processes and threads,
and the tool description says so. The filter list must be revisited when
the guest kernel changes, and a new route found by a test is a new list
entry. The floor catches only fills slower than about 1.2 GiB/s, and it,
the `clone` entries, the job-wide Unix socket total and the 20 ordinary
checks under the new limits are measured in S-18. Whether `nitro` and
`agentcore` need the filter for socket memory is open: S-16 bounded
`memfd` and tmpfs there, not that route; the SysV sweep covers the
objects that outlive a job. With no warm instance, every `nitro` start
after two idle minutes is a cold start of about 30 s.
