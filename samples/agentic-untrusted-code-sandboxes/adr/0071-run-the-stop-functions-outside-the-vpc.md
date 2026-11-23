<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0071: Run the reaper, offboard and drain functions outside the VPC

- Status: Accepted
- Date: 2026-11-23
- Amends: ADR-0012, ADR-0029
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

ADR-0012 and ADR-0029 put every core function in the tool subnets: the
run function, the reaper, the offboard function and the drain. Only the
run function dials a sandbox (the `nitro` task's private IP). The reaper,
offboard and drain call AWS APIs only: ECS, Lambda MicroVM, AgentCore,
EC2 and DynamoDB. None of them reads a runner.

A function in a VPC holds Lambda-managed network interfaces, which Lambda
releases some time after the function is deleted. Integration runs 12, 13
and 14 ended `DELETE_FAILED` in 8 of 9 stacks on two such interfaces,
from the reaper and the offboard function, still `available` when the
stack deleted the tool subnets and security group. The spec's stack
delete times (§7.8) also name the late release of the drain's interfaces
as the larger part of a 21 to 27 minute delete.

## Options considered

### Option 1: Take the three stop functions out of the VPC
Pros: they leave no interface, so the delete has nothing to wait for or
leak; their roles lose the six network interface actions on `*`; no NAT
traffic for their API calls. Cons: their calls go to the public AWS
endpoints, not through the VPC; the tool subnets no longer hold every
trusted function.

### Option 2: Keep them in the VPC and delete leftover interfaces on stack delete
Pros: no placement change. Cons: another custom resource that deletes
interfaces by description, with `ec2:DeleteNetworkInterface` on `*`,
ordered between the functions and the subnets; it hides the leak instead
of removing it, and every delete still waits for the release.

### Option 3: Keep them in the VPC and document the manual cleanup
Pros: nothing to build. Cons: the integration test is not green, and an
adopter's `cdk destroy` fails most of the time.

## Decision

Option 1. `lambdaFunction` attaches a function to the tool subnets and
the tool security group only when it dials a sandbox (`inVpc`, the
standalone run function). A function bound with `bindRunCode` still gets
the tool subnets. The reaper and drain roles no longer carry the network
interface statement; the tool role keeps it. The sample has no earlier
release, so no deployed stack moves its functions out of the VPC in an
update. A fork that does should keep the statement for one deploy, until
Lambda has released the old interfaces.

## Consequences

A stack delete waits only on the run function's interfaces, and the
integration test's `teardown` step is the proof. The architecture diagram
draws the stop functions outside the VPC. The stop functions reach AWS
APIs over the internet path that Lambda provides, which is how any
function outside a VPC calls AWS; the API calls carry no tenant code or
bytes. If a vendor's account requires every function in a VPC (an SCP or
a Config rule), the three functions would need the tool subnets back and
Option 2's cleanup with them.
