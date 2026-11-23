<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0073: Keep a VPC function's role until its network interfaces are released

- Status: Accepted
- Date: 2026-11-23
- Amends: ADR-0029
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Integration runs 5 to 14 ended `DELETE_FAILED` in all but one stack: two
Lambda-managed network interfaces stayed `available` in the tool subnets
and held the subnets and the tool security group. ADR-0071 took the
reaper, offboard and drain functions out of the VPC. Run 17 then left the
same two interfaces, now described as the run function's. So the leak was
never specific to those functions.

CloudTrail for run 14 showed the pattern: Lambda deletes a function's
interfaces with the function's own role, about a minute after the
function is gone. The role's policy, which holds the network interface
actions (ADR-0029), was deleted one second after the function, and no
`DeleteNetworkInterface` call was ever made for the leftover interfaces.
Run 17 repeated it: the run function's delete completed at 12:45:41 UTC
and the tool role's policy went at 12:45:42.

## Options considered

### Option 1: Hold each VPC function's role and policy behind a delete-time wait
Pros: the role keeps its rights until Lambda has released the interfaces;
uses the waiter the construct already has (`LogDrain`). Cons: two more
minutes on every delete; a second waiter, because the role's policy names
backend resources that wait for the log drain, and protecting the role
with the log drain would be a dependency cycle.

### Option 2: Delete leftover interfaces from a custom resource
Cons: `ec2:DeleteNetworkInterface` on `*` for a new role, matched by
description; it hides the race instead of removing it.

### Option 3: Keep the managed VPC access policy on the roles
Cons: CloudFormation deletes a managed policy attachment with the role as
well, so the race stays; and the managed policy allows log writes on
every group (ADR-0029).

## Decision

Option 1. A second `LogDrain` instance, `NetworkDrain`, waits 120 s on
delete. Every function in the tool subnets (the standalone run function
and every function bound with `bindRunCode`) is deleted before it, and
that function's role and its policy after it. Functions outside the VPC
(ADR-0071) are not involved.

## Consequences

A delete takes about two minutes longer. The integration test's
`teardown` step is the proof; the unit tests pin the order for the
standalone and the bound functions. A function an app builds in the tool
subnets without `bindRunCode` is outside this order, and its role should
outlive it the same way.
