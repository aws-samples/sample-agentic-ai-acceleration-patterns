<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0048: Scope the nitro statements by the condition keys each action supports

- Status: Accepted
- Date: 2026-11-20
- Amends: ADR-0014
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0014 puts the tenant tag on `RunTask` and `StopTask`. The statements
for the tool role, the tenant role, the reaper and the drain (spec §3.6)
each name an ECS action, and an IAM condition key that the action does not
support makes the statement match nothing, which a deploy shows only at the
first call. The Service Authorization Reference (checked 2026-11-20) shows
that `ListTasks` authorises on a container instance with the key
`ecs:cluster`, that `TagResource` has no `ecs:cluster` key, and that
`DeregisterContainerInstance` has none either.

## Options considered

### Option 1: Follow the reference per action, and test the keys and the denials
Pros: each statement is as narrow as its action allows; a unit test
catches a wrong key before a deploy. Cons: the table in the test is a
copy of the reference.

### Option 2: Scope everything by the cluster ARN as a resource
Pros: simple to read. Cons: wrong for the actions that take no cluster
resource.

## Decision

Option 1.

| Statement | Action | Resource | Conditions |
|---|---|---|---|
| tool role | `DescribeTasks` | tasks of the cluster | none |
| tenant role | `RunTask` | the pinned task definition revision | `ecs:cluster` = the cluster, `aws:RequestTag/TenantId` = `${aws:PrincipalTag/TenantId}` |
| tenant role | `TagResource` | tasks of the cluster | `aws:RequestTag/TenantId` = the principal tag, `ecs:CreateAction` = `RunTask` |
| tenant role | `StopTask` | tasks of the cluster | `ecs:cluster` = the cluster, `aws:ResourceTag/TenantId` = the principal tag |
| tenant role | `PassRole` | the execution role | `iam:PassedToService` = `ecs-tasks.amazonaws.com` |
| reaper | `ListTasks` | `*` | `ecs:cluster` = the cluster |
| reaper | `DescribeTasks`, `StopTask` | tasks of the cluster | none |
| drain, on top | `ListContainerInstances`, `DeregisterContainerInstance` | the cluster | none |
| drain, on top | `DescribeContainerInstances` | container instances of the cluster | none |
| drain, on top | `ec2:DescribeInstances` | `*` (takes no resource) | none |

The synth tests carry a table of the keys each action supports and check
every condition of every statement against it. They also evaluate the
statements as an allow-only policy against requests: another tenant's tag,
a missing tag or cluster, another task definition, another role, and a
`StartTask` or a retag all get no match, and the reaper and the tool role
hold none of the drain's or the tenant's actions.

## Consequences

`ListTasks` is a `*` resource with a cluster condition, which cdk-nag's
IAM5 rule reports on the core's role policies; the core acknowledges it
with this ADR as the reason. Revisit the `ListTasks` statement when the
integration test shows how ECS authorises it.
