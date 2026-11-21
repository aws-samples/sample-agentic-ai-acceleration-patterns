<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0064: Read an unframed request as empty and bound the work after a job

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0039
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Four points of ADR-0039 did not hold against the platforms or each other.

- The MicroVM platform calls the `suspend` hook with no body and no
  `Content-Length`. The runner read that as a broken request and answered
  400, so an idle MicroVM was terminated instead of suspended.
- After the wall timeout the runner kills the group, sweeps `/tmp`, `/dev/shm`
  and the SysV objects, and joins its threads, each step with its own 5 s limit.
  The tool waits `timeoutMs` plus 5 s, so a slow reap lost the result, the
  `memoryExceeded` flag and the `dirty` mark.
- ADR-0039 allowed TLS 1.2 on `nitro`, while the tool requires TLS 1.3 and
  ADR-0047 relies on it.
- On `microvm` a failed claim left the hook accepted and jobs answering
  `tool_failed`, and the platform waited out its 20 s start cap.

## Options considered

### Option 1: Keep the 400 and ask the platform to send a body
Pros: no change. Cons: the platform sends the hook; the sample cannot change it.

### Option 2: Read a request with no `Content-Length` and no chunked encoding as an empty body
Pros: RFC 9112 section 6.3 says so, and the hook port needs nothing else. The
job port still refuses an empty body. Any other `Transfer-Encoding` stays a
400 that closes the connection, so the bytes after it are never read as a
second request. Cons: a job with no body needs its own refusal.

### Option 3 (post-job work): raise the tool's margin instead of bounding the runner
Pros: no runner change. Cons: every caller waits longer, and the gateway check
of 90 s moves.

## Decision

Option 2 for requests. After a job ends, the kill, the sweep and the thread
joins share one budget of 3 s, so the answer comes with 2 s to spare. A step
the budget cuts short, or a process that survives the kill, marks the sandbox
`dirty`, on every backend. The runner's TLS on `nitro` is TLS 1.3 only. On
`microvm` a failed claim sets the flag a forced failed start sets, so the
runner exits and the start fails at once; the hook still answers 200 and
`ready` answers 503.

## Consequences

A runaway job that is slow to reap now returns its result with `dirty` set,
and the tool replaces the sandbox, instead of returning `no_answer`. A sweep
that needs more than 3 s is reported dirty, not waited for. Raising the
budget needs the tool's 5 s margin raised with it.

Note 2026-11-20: on `agentcore` the runner reads the job group's memory again, for up to 1 s of the 3 s budget, before it calls the group not drained, because memory the sweep freed takes a moment to show.

Note 2026-11-21: the read is repeated for the rest of the 3 s budget, not 1 s. The integration test's `runaway` step on `agentcore` saw the runner call the group not drained after a disk fill (first read as a slow `memfd` drain); the longer poll did not change that, and the runner now logs the group's memory split with `dirty` so the cause can be read.

Note 2026-11-21 (later): the logged split after a disk fill showed the 215 MiB left over was kernel slab (anon 0, shmem 0, file already left out). The dirty read now also leaves out `slab_reclaimable` (dentries and inodes the kernel frees under pressure) and keeps unreclaimable slab, where SysV semaphores and message queues are charged (S-18). The 32 MiB limit is unchanged. The split of the 215 MiB between the two is not yet measured; the runner logs it (`slab_reclaimable_mib`, `slab_unreclaimable_mib`) with `dirty_group` when the group stays dirty, and with `clean_by_reclaimable_slab` when leaving out reclaimable slab is what made it clean, so the next integration run shows it either way.
