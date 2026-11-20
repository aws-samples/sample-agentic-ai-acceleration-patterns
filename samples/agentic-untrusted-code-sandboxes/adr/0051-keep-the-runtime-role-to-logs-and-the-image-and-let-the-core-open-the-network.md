<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0051: Keep the runtime role to logs and the image, and let the core open the network

- Status: Proposed
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Code in an AgentCore session reads the runtime role's credentials from the
metadata service (S-10, spec §3.4 "Code holds"). The role is therefore the
widest thing a hostile script holds on this backend, and spec §3.6 limits it
to the runner image pull and the runtime's own log groups, plus the
per-session S3 prefix with `sessionFiles` (ADR-0007).

The CDK `Runtime` construct (`aws-cdk-lib` 2.274.0) adds grants to the
execution role it is given, whether it made the role or not: log access on
`/aws/bedrock-agentcore/runtimes/*`, `logs:DescribeLogGroups` on every log
group, X-Ray writes, CloudWatch `PutMetricData`, and workload-identity token
actions. The artifact class that takes an ECR repository also grants pull on
the role. Spike S-10 found `logs:DescribeLogGroups` refused at the prefix
and not needed.

The sandbox endpoints and the egress that reaches them belong to the core,
which builds each endpoint once for every backend that asks for it, writes
its policy, and adds each client's egress and each endpoint group's ingress
(`BackendConstruct.endpoints()` and `endpointClients()`).

## Options considered

### Option 1: Hand the construct an immutable reference to a role this backend wrote
Pros: the L2 cannot add a statement to a role it cannot change, so the role is
exactly the four or six statements in `agentcore.cdk.ts`; the image is
referenced by URI, so the artifact adds no grant either. Cons: the runtime
must depend on the role and its policy explicitly, and a later change to the
L2's defaults (a new grant the platform needs) shows up as a failed start,
not a diff.

### Option 2: Let the L2 make the role, then remove its statements
Pros: fewer lines. Cons: CDK has no supported way to remove a statement, and
an escape-hatch edit of the generated policy breaks with the next minor
version.

### Option 3: Accept the L2's grants
Pros: the platform works as its authors tested it. Cons: code in a session
could write to any `/aws/bedrock-agentcore/runtimes/*` group in the account,
list every log group, and write traces and metrics; contradicts spec §3.6.

For the security group: give the backend its own egress rules (the endpoint
subnets' CIDRs and an S3 prefix list), or leave the rules to the core.
Own rules need the prefix list id, which CloudFormation cannot read, so the
construct would add a custom resource and a Lambda for one lookup, and the
core already adds the same endpoint egress for every client. The backend
leaves the rules to the core.

## Decision

Option 1. The role trusts `bedrock-agentcore.amazonaws.com` for this account
and for `runtime/<runtimeName>-*` only (runtime names cannot contain `-`, so
the pattern matches one runtime). Its policy holds `ecr:GetAuthorizationToken`
on `*` (the action takes no resource), `ecr:BatchGetImage` and
`ecr:GetDownloadUrlForLayer` on the runner repository, the log actions on
`/aws/bedrock-agentcore/runtimes/<runtimeName>-*` and its streams, and with
`sessionFiles` the two S3 statements of ADR-0007. The runtime waits for the
role and its policy.

The security group has no ingress and no egress of its own and is returned
by `endpointClients()`. Spec §3.7 states what the core must open for it: 443
to the ECR and Logs endpoint groups and to the S3 prefix list (in the VPC the
core creates, where the sandbox route table has no default route, any address
on 443 stands in for the prefix list, which CloudFormation cannot read; a
supplied prefix list id narrows it). The runtime waits for its security group
and the rules the core adds to it, because it is created in the sandbox
subnets; ordering it after the endpoints themselves is the core's, through
`drainOrder()`.

## Consequences

The trust condition names `runtime/<runtimeName>-*`, the shape the CDK
`Runtime` construct writes for the role it creates (`<runtimeName>*`), narrowed
here by the `-` that precedes the id the service appends; AWS documents the wider
`<account>:*` form, and no spike ran either. If a runtime fails to start with
the narrow form, the fallback is the documented form with the account
condition kept, and this record is superseded. The runtime name is checked
at synth against the service's pattern, so a `-` cannot widen the log and
trust patterns.

A synth test asserts the exact set of statements on the role, that none of
the L2's grants is present, and that the only wildcard resource is the ECR
token action. The integration test's `no-egress` step proves the network
side.
