<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0012: Split the VPC into tool subnets and dead-end sandbox subnets

- Status: Proposed
- Date: 2026-11-18
- Amended by: ADR-0015
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The tool must reach STS, KMS, DynamoDB, S3, ECS, the MicroVM API and
endpoints, and the AgentCore data plane, and on `nitro` the tasks' private
IPs. The ECS Managed Instances must reach ECS and ECR. The sandboxes must
reach nothing, except what `agentcore` needs to run (ECR, S3 layers, Logs)
and what `nitro` tasks need to log. One set of subnets cannot serve both.

## Options considered

### Option 1: Tool subnets with a NAT; sandbox subnets with no default route and scoped endpoints
Pros: the trusted side reaches everything with one NAT; the sandbox side
has only endpoints, and each endpoint's policy names the sample's own
repository, the ECR layer bucket, and the sample's log groups, so an open
path cannot carry data to an outside bucket or log group. Cons: a NAT and
two to four interface endpoints bill per hour.

### Option 2: Everything in isolated subnets with a full endpoint set
Pros: no NAT. Cons: about ten interface endpoints, including the MicroVM
connectivity service, and the tool's endpoints would sit beside the
sandboxes.

### Option 3: Tool Lambda outside any VPC
Pros: cheapest. Cons: cannot reach `nitro` task IPs.

## Decision

Option 1 (spec §3.7). The S3 gateway endpoint is attached to the sandbox
route table only, so its policy binds only the sandboxes. Interface
endpoints use private DNS, which applies to the whole VPC, so they admit
the sandbox security groups and the ECS instance group; their policies
name only the sample's repository and log groups, which is all either side
uses. When a supplied `vpc` already has these endpoints, `createEndpoints`
is set to `false` and the vendor's endpoints must meet the same rules.

## Consequences

Deploy time and hourly cost include the NAT and the endpoints; the README
cost section shows them. The integration test tries a presigned PUT to an
outside bucket through the S3 endpoint. A vendor who supplies `vpc` must
tag both tiers.

Note 2026-11-18: amended by ADR-0015. ECR and S3 endpoints in the sandbox subnets serve `agentcore` only; the `nitro` task needs only the Logs endpoint, because the instance pulls the image.
