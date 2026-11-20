<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0049: Read a stopping task as live, and end the instances in the backend

- Status: Proposed
- Date: 2026-11-20
- Amends: ADR-0011
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

`StopTask` sets a task's desired status to `STOPPED` at once, but the task
keeps running for 45 to 78 s (S-7), and a capacity provider cannot be
deleted while a task is still stopping (spec §5.3). `ListTasks` with its
default filter drops such a task, so a drain that waited for the list to be
empty would stop waiting too early. After the tasks end, an idle managed
instance still blocks the capacity provider delete, and S-16 showed a
forced deregister ends it in 17 to 30 s. After any kernel kill of a job,
ECS marks the container `OutOfMemoryError` even when the runner exited 0.

## Options considered

### Option 1: The backend lists both desired statuses, reports `live` from `lastStatus`, and owns the instance drain in `cleanup(deadlineMs)`
Pros: the core's drain and reaper stay free of ECS details; `live` stays
true until ECS says `STOPPED`. Cons: two list calls and a describe per page.

### Option 2: The core drain calls ECS itself
Pros: one fewer abstraction. Cons: the core would hold backend-specific
code that it cannot test.

## Decision

Option 1. `list()` reads `ListTasks` with desired status `RUNNING` and
`STOPPED`, describes the tasks in chunks of 100 with their tags, and
yields each once; `live` is false only when `lastStatus` is `STOPPED`.
`isAlive` follows `live`: true until ECS reports the task `STOPPED`, a
stopping task included, so the offboard function keeps a row while the task
stops and the reaper does not stop it again as an orphan.
`cleanup(deadlineMs)`, with the deadline
as an absolute time in epoch milliseconds, lists the cluster's `ACTIVE` and
`DRAINING` container instances, deregisters each with `force`, waits until
`DescribeInstances` shows each one `terminated` (or no longer known), and
repeats until the cluster lists none. The runner counts as crashed only on a
non-zero exit code, so an `OutOfMemoryError` with exit code 0 leaves the stop
reason as ECS wrote it. The task log group has no separate drain: the
execution role cannot create log groups, so late lines do not bring a
deleted group back, and the core's log cleanup resource deletes the group by
name after the cluster.

## Consequences

The core's drain calls `cleanup` once, after every task is `STOPPED`, with a
deadline inside its 10-minute bound. A stop line for a task the platform
ended carries `stoppedReason` and, for a runner crash, its exit code.

Two answers depend on how ECS behaves right after a start and long after a
stop. `ready` reads a task that `DescribeTasks` does not list as not yet
visible while its row is under 30 s old, and as ended after that, because ECS
is eventually consistent. `stop` with the tenant credentials treats an
`AccessDenied` as already stopped when the ambient role finds the task
missing or `STOPPED`: for a task ECS dropped from its history an hour after
it stopped there is no tag for the condition to check. A task that still
runs keeps the error. Neither answer has been seen against a live ECS; the
integration run is the first check of both. `cleanup` waits between passes
when a pass found no instance id, and asks EC2 id by id when one id is
unknown, so one forgotten instance does not hide a live one.

The integration run also checks that `DescribeTasks` with `include: TAGS`,
which `list` uses to read each task's `TenantId`, needs no
`ecs:ListTagsForResource` beyond `ecs:DescribeTasks`. The reaper and tool
statements grant only the latter, and a denial would fail every `list`.

`isAlive` has no grace for a task that `DescribeTasks` does not show yet,
because the backend cannot see how old the row is. The reaper calls it for a
starting row whose task it did not list (the list is read before the rows),
so a start that began after the list could be read as failed on the first
pass if ECS shows the task late. The integration run checks whether ECS
does; the reaper can skip a starting row younger than the `ready` grace.
