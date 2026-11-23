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
same two interfaces, now described as the run function's, so the leak is
not specific to those functions.

CloudTrail for run 14 showed the pattern. Lambda deletes a function's
interfaces with the function's own role after the function is gone: the
`run-code-files` drain role deleted its own two interfaces about 45 s
after its function went. The reaper role's policy, which held the network
interface actions (ADR-0029), was deleted one second after the last
function using it, and no `DeleteNetworkInterface` call was ever made for
its two interfaces. Run 17's stack events show the same order (CloudTrail
was not read for it): the run function's delete completed at 12:45:41 UTC
and the tool role's default policy went at 12:45:42.

## Options considered

### Option 1: Hold each VPC function's role and its network interface rights behind the log drain
Pros: the role keeps its rights until Lambda has released the interfaces;
uses the waiter the construct already has (`LogDrain`, 90 s). Cons: the
network interface actions move into a policy of their own per role,
because the role's default policy names the backends' resources, which
wait for the log drain themselves; holding that policy would be a cycle.

### Option 2: Delete leftover interfaces from a custom resource
Cons: `ec2:DeleteNetworkInterface` on `*` for a new role, matched by
description; it hides the race instead of removing it.

### Option 3: Keep the managed VPC access policy on the roles
Cons: a managed policy attachment is a property of the role, so it goes
with the role, seconds after the function, and the race stays; the
managed policy also allows log writes on every group (ADR-0029).

## Decision

Option 1. Each role of a function in the tool subnets (the tool role, and
the role of every function bound with `bindRunCode`) gets a policy of its
own, `VpcNetworkInterfaces`, with the six network interface actions and
nothing else. The function is deleted before the log drain's 90 s wait,
and the role and that policy after it. The wait starts once the last
function that writes to the drain is gone, so it also covers an interface
that several functions share and Lambda deletes with any of their roles.
`bindRunCode` refuses a role in another stack than the construct: such a
role was never deployable, because each stack would depend on the other.

## Consequences

A delete takes a few seconds longer: the log drain already waited 90 s
for its other writers, the run function among them. The 90 s rests on one
observation (about 45 s in run 14); a miss
shows as the same `DELETE_FAILED` on the tool subnets. The integration
test's `teardown` step is the proof; unit tests pin the order for the
standalone function, bound functions and a function bound with the tool
role, and that a bound function granted to invoke another, or the
standalone function, still synthesises.
A stack update that removes a bound function, or replaces its role,
deletes the role at once with no wait, and can leave that function's
interfaces behind. A function an app builds in the tool subnets without
`bindRunCode` is outside this order, and its role should outlive it the
same way.
