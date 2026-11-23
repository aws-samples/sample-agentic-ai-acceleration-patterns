<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0046: Write the nitro task definition in L1, with no task role and the isolation mode as an override

- Status: Accepted
- Date: 2026-11-20
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

The `nitro` task must have no task role (spec §3.4 "Code holds", S-5) and
must ask for `ISOLATED_SANDBOX`. At `aws-cdk-lib` 2.274.0 the L2
`TaskDefinition` always creates a task role, and neither the L1 nor the L2
types carry `TrustedExecutionConfiguration` (ADR-0023). The CloudFormation
schema that CDK validates against does not know the property either, so
synth prints a validation warning for it.

## Options considered

### Option 1: `CfnTaskDefinition` with `addPropertyOverride`
Pros: no task role is ever created, so nothing has to be removed; every
property the sample sets is visible in one place; `Ref` is the revision
ARN that the tenant role's `RunTask` statement names. Cons: no L2 helpers
for the image and the log driver; one untyped override.

### Option 2: The L2 `TaskDefinition`, then delete the task role and its reference
Pros: typed container helpers. Cons: deleting a construct and a property
afterwards is a trap for the next reader.

## Decision

Option 1. The task definition has the execution role, `awslogs` to the
construct's task log group, one container named `runner` on 8443, no
added capability and no task role, and `TrustedExecutionConfiguration`
`{ IsolationMode: ISOLATED_SANDBOX }` as an override. The container sets
`RUNNER_BACKEND=nitro` (ADR-0037); the nonce hash comes per start from the
container override. The CloudFormation
validation finding for the unknown property (`F3002`) is acknowledged with
a reason that cites the spikes, which deployed the property in raw
CloudFormation. The image is the construct repository at the tag the core
made for the architecture of `nitro.instanceTypes`. Tests assert the
override, the missing task role (three roles in the stack: execution,
instance, infrastructure), the missing capabilities, and that the L1 types
still lack the property; when that last test fails, the override goes.

## Consequences

The exact CloudFormation spelling of the override is the one from the spec
and ADR-0004. The first smoke deploy in a test account accepted it, and
ECS refused every task until the capacity provider also set
`InstanceLaunchTemplate.NitroEnclavesEnabled`: a task with the isolation
mode launches only on a provider that enables Nitro Enclaves. The
construct sets both. The tenant role starts the
pinned revision, so a change to the task definition replaces the revision
and the tool functions' environment in one deploy.
