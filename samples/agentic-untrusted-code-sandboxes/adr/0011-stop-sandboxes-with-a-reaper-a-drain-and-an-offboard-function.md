<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0011: Stop sandboxes with a reaper, a drain and an offboard function

- Status: Proposed
- Date: 2026-11-18
- Amended by: ADR-0015, ADR-0019, ADR-0020
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Sandboxes are started at run time, outside CloudFormation. ECS tasks have
no idle stop and block the cluster's delete while they run. MicroVMs and
AgentCore sessions end on their own idle and life settings, but not on
`cdk destroy`. A crashed start can leave a sandbox with no row. A tenant
that leaves must not keep a running sandbox.

## Options considered

### Option 1: A scheduled reaper, a delete-time drain, and an offboard function
Pros: idle `nitro` tasks stop; orphans are found by tag or image; `cdk
destroy` stops everything before the resources it depends on go (C-6); the
control plane's tenant delete script has one call to make. Cons: three
small functions and a role that can see every row.

### Option 2: A task per call with no reuse on `nitro`
Pros: nothing to reap. Cons: rejected in ADR-0005.

### Option 3: Leave stopping to the test
Pros: no code. Cons: a consumer's `cdk destroy` fails or leaks.

## Decision

Option 1 (spec §4.1, §5.2, §5.3). The reaper and the drain use a role that
reads, updates and deletes every registry row and can stop the sample's
sandboxes, and that cannot read the input bucket. Because ECS has no task
life limit, the reaper also stops any tagged task whose own `startedAt` is
older than `sandboxMaxLife`, with or without a row. AgentCore has no API
that lists a runtime's sessions, so the sweep covers tasks and MicroVMs
only; an orphan session ends on its idle or life timeout or with the
runtime's delete. The reaper checks each `READY` `microvm` row with `GetMicrovm`
and writes the stop line for a MicroVM the platform ended. For `STARTING`
rows it applies the tool's own rule, and it leaves `FAILED` rows to the
tool. The drain waits up to 10 minutes for tasks and MicroVMs
and fails the delete loudly if any is left.

## Consequences

The reaper runs every 5 minutes, so a `nitro` task lives up to
`sandboxIdle` + 5 minutes after its last call. Each sandbox gets exactly
one `sandboxSeconds` stop line (ADR-0013): from whoever moves its row out
of `STARTING` or `READY`, or, for an orphan with no row, from the sweep or
the drain, marked `orphan` and attributed by the sandbox's tag where it
has one. An `agentcore` orphan session is the exception: it cannot be
listed, so it gets no line, and its cost comes from AgentCore's usage
logs. The registry's TTL runs an hour after expiry, so the reaper sees an
expired row first. Offboarding does not delete
tenant objects (spec §1.2).

Note 2026-11-18: amended by ADR-0015. The drain waits until every task is `STOPPED` and every MicroVM of the image is `TERMINATED` before the stack's resources are deleted, and the log cleanup resource also deletes the MicroVM image build log group.

Note 2026-11-19: amended by ADR-0019. An idle ECS managed instance blocks the capacity provider delete. So once every task has stopped the drain deregisters the cluster's container instances with `force`, which on ECS Managed Instances terminates them, and waits until EC2 shows each one `terminated`. S-16 measures how long that takes and whether a minimum above 0 starts a replacement first.

Note 2026-11-19: amended by ADR-0020. S-16 measured the drain: a forced deregister ended each instance in 17 to 30 s, no replacement started, and the stack delete then succeeded first time in 38 s. The capacity provider has no minimum-instances setting, so the sample keeps no warm instance.
