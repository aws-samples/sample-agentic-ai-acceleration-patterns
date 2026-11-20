<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0028: Give each endpoint class its own security group, and bound S3 egress by routing

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Spec §3.7 puts the ECR, S3 and Logs endpoints in the sandbox subnets with
scoped policies, and says which group may reach which endpoint: a `nitro`
task reaches the Logs endpoint only; an `agentcore` runtime reaches the ECR
and Logs endpoint groups and "the S3 prefix list" on 443. The interface
between the core and a backend (`BackendConstruct`, ADR-0025) lists only
`endpoints()` and `endpointClients()`; the backends build their security
groups before the core builds the endpoints, so they cannot name an
endpoint group. CloudFormation also has no way to read the managed prefix
list id of the S3 gateway endpoint.

## Options considered

### Option 1: The core owns the endpoint groups, and adds each client's egress from that backend's `endpoints()`
Pros: no change to the shared interface; the task group gets the Logs group
only because the `nitro` backend asks for `logs` only. Cons: the S3 egress
cannot name the prefix list.

### Option 2: One security group for all interface endpoints
Pros: simplest. Cons: a `nitro` task would reach the ECR endpoint too,
contrary to the spec.

### Option 3: Look up the prefix list id with a custom resource
Pros: matches the spec text. Cons: another Lambda and role in the stack for
one rule.

## Decision

Option 1, with two security groups (ECR api and dkr share one, Logs has its
own), no egress, and 443 ingress from every client of every backend, so a
group that reaches an endpoint through private DNS is admitted. Each
client's own egress rules go to the endpoint groups its backend asked for.
For `s3-gateway` the egress is 443 to any address. The sandbox subnets have
no default route, so the only route a packet can take on 443 is the S3
gateway endpoint's prefix list route, which the endpoint policy bounds to
the ECR layer bucket (and the `sessions/` prefix with `sessionFiles`).

## Consequences

The security group alone does not name S3. The route table, the endpoint
policy and the role policy do; the integration test's presigned PUT to a
bucket outside the policy is the check (spec §3.7). Revisit when
CloudFormation exposes the prefix list id; one rule in
`src/core/endpoints.ts` changes.
