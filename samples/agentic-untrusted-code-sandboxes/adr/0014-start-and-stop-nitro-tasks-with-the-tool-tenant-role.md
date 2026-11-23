<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0014: Start and stop nitro tasks with the tool tenant role

- Status: Accepted
- Date: 2026-11-18
- Amended by: ADR-0048
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ECS supports `aws:RequestTag` on `RunTask` and `aws:ResourceTag` on
`StopTask`. Requiring a `TenantId` tag from the tool's own role only proves
that some tag was set, because that role chooses the value; that is
filtered. The tool tenant role carries the verified `TenantId` as a session
tag.

## Options considered

### Option 1: `RunTask` and `StopTask` with the tool tenant role, tag equal to the principal tag
Pros: IAM refuses to start a task tagged for another tenant or to stop one
(enforced). Cons: the tenant role also needs `iam:PassRole` on the task
execution role and `ecs:TagResource`.

### Option 2: The tool's own role with a required tag
Pros: one role. Cons: filtered, as above.

## Decision

Option 1. `RunTask` is allowed on the pinned task definition revision ARN only, with
`aws:RequestTag/TenantId` = `${aws:PrincipalTag/TenantId}` and
`ecs:cluster` = the sample's cluster. `ecs:TagResource`, which ECS checks
for the tags passed to `RunTask`, is allowed on `task/<cluster>/*` with the
same request tag condition and `ecs:CreateAction` = `RunTask`; it supports
no `ecs:cluster` key. `StopTask` requires `aws:ResourceTag/TenantId` =
`${aws:PrincipalTag/TenantId}` and `ecs:cluster`. `iam:PassRole` is
limited to the one execution role with `iam:PassedToService` =
`ecs-tasks.amazonaws.com`. A unit test checks every condition key against
the keys its action supports.

## Consequences

The call path to a task stays filtered by address; ADR-0010 covers it. The
reaper and the drain stop tasks with their own role, which is not
tenant-scoped and reads no tenant data. If S-3 or S-8 find equivalent keys
for MicroVMs or AgentCore sessions, the same move applies there.

Note 2026-11-20: amended by ADR-0048. The conditions are checked against the keys each ECS action supports; the reaper lists tasks on `*` with the `ecs:cluster` key, because `ListTasks` authorises on a container instance. A tool-path `StopTask` for a task ECS has dropped from its history is treated as already stopped (ADR-0049).
