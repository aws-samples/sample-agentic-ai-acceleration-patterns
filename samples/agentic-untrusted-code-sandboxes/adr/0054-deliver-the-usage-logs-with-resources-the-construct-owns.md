<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0054: Deliver the usage logs with resources the construct owns

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

Cost on `agentcore` is attributed from the runtime's session-level usage
logs, joined to the tenant through `runtimeSessionId` in the tool's run line
(spec §3.8). The platform delivers them with CloudWatch vended-log resources:
a delivery source (the runtime, log type `USAGE_LOGS`), a delivery
destination (a log group) and a delivery. The CDK `Runtime` construct can
create these from a `loggingConfigs` entry, but it names them from the
construct path with its own hash, and it adds a delivery policy to the stack
under a fixed id, which counts against the account's limit of 10 CloudWatch
Logs resource policies per Region and is shared by every runtime in the
stack. Spec §5.3 asks for names from the sanitiser (`log-delivery`, 60
characters, unique per account and Region) and §3.9 shows the pattern for a
policy the instance owns.

AgentCore also writes the runtime's own application logs under
`/aws/bedrock-agentcore/runtimes/<runtimeName>-<id>-DEFAULT` after the
deploy, so the stack cannot own those groups.

## Options considered

### Option 1: Write the three resources and the policy here, with the sanitiser's names
Pros: names and policy are this instance's; the usage log group is a
construct-owned group, deleted with the stack. Cons: about 40 lines the L2
would have written.

### Option 2: Use `loggingConfigs`
Pros: less code. Cons: names outside the sanitiser, and a stack-wide policy
that other deployments in the account can overwrite.

### Option 3: No usage-log delivery
Pros: nothing to deploy. Cons: no per-tenant cost for this backend.

## Decision

Option 1. The log group is named by the sanitiser, keeps logs for 30 days and
is removed with the stack. The resource policy lets
`delivery.logs.amazonaws.com` write streams to that group only, conditioned on
the account and on a CloudWatch Logs source ARN; it is named by the sanitiser
(`logs-resource-policy`). The delivery destination waits for the policy, and
the delivery for the source and the destination. The runtime's own log groups
are removed by the core's log cleanup resource, which takes the prefix
`/aws/bedrock-agentcore/runtimes/<runtimeName>-` from `logCleanup()` and runs
after the runtime (`drainOrder()` returns the runtime). The same prefix names
the runtime role's log grants and, through the core, the Logs endpoint
policy.

## Consequences

A synth test asserts the three resources, their names, the log type, the
policy and each ordering. The usage log's field names and delivery lag are
unmeasured; the integration test reads the delivered records. Late delivery
after the stack's group is gone is not drained (a 90 s drain like the
runtime-isolation sample's exists for log groups written by a service that
outlives the writer); this group's writer is deleted first, and the group
holds nothing the sample needs after the delete.
