<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0026: Defer `requireMMDSV2` until CloudFormation exposes it

- Status: Accepted
- Date: 2026-10-30
- Amends: ADR-0008
- Deciders: Dave Roberts (PSA)

## Context
ADR-0008 decided the execution role holds nothing tenant-scoped, "plus
`requireMMDSV2: true`", so that code in the microVM reads the role credential
from the metadata service only with a session token. The sample never set it.
The AgentCore control API has the setting: `RuntimeMetadataConfiguration`
with a required `requireMMDSV2` boolean, accepted as `metadataConfiguration`
by `UpdateAgentRuntime` and returned by `GetAgentRuntime`, but not accepted by
`CreateAgentRuntime` (botocore service model `bedrock-agentcore-control`
2023-06-05, read 2026-10-30). The `AWS::BedrockAgentCore::Runtime` resource
has no such property: `CfnRuntimeProps` in the pinned aws-cdk-lib 2.274.0
(`package.json`, `cdkVersion` in `.projenrc.ts`), which is generated from the
CloudFormation resource schema, lists no metadata or MMDS property. The
Runtime is created in `src/backend/agentcore-runtime.cdk.ts` with `CfnRuntime`.

Since ADR-0018 the execution role grants CloudWatch Logs and X-Ray writes only
(no model, no data, no `sts:*`; pinned by `test/runtime-isolation.cdk.test.ts`),
so a credential read from MMDS reaches nothing tenant-scoped. Threat model
T-13 and M-7 record `requireMMDSV2` as a follow-up.

## Options considered
### Option 1: Raw property override on `CfnRuntime`
`addPropertyOverride('MetadataConfiguration', { RequireMMDSV2: true })`.
Pros: one line, no extra resource. Cons: the property does not exist in the
resource schema the L1 is generated from, so the template carries a key the
resource type does not define and the sample would depend on how the handler
treats it; not tried. ADR-0010's raw override is typed against a documented
property, which this would not be.

### Option 2: Wait for the CloudFormation resource type to gain the property
Pros: no custom code; when it lands it is one typed prop on `CfnRuntime`, and
a unit test can pin it. Cons: the microVM keeps accepting MMDSv1 until then.

### Option 3: Set it after deploy with a custom resource calling `UpdateAgentRuntime`
Pros: the setting is live today. Cons: `UpdateAgentRuntime` requires
`agentRuntimeArtifact` and `roleArn`, so the custom resource restates the
Runtime's configuration outside CloudFormation; a later stack update of the
Runtime can reset the setting or drift from it; one more Lambda, role and
cdk-nag acknowledgment for a control whose residual is already small.

## Decision
Option 2. With the execution role reduced to logs and traces (ADR-0018),
MMDSv2 is defence in depth rather than the boundary, and a second writer of
the Runtime's configuration outside CloudFormation would cost more in drift
and code than the residual it removes; the sample sets `requireMMDSV2: true`
on `CfnRuntime` once the resource type exposes it.

## Consequences
Easier: one source of truth for the Runtime's configuration, no extra custom
resource. Harder: code in the microVM can read the execution-role credential
over MMDSv1; it can write logs and traces only (threat model T-13, T-24,
M-7). Follow-up: when `AWS::BedrockAgentCore::Runtime` gains the property,
set it in `src/backend/agentcore-runtime.cdk.ts`, add a unit test, and close
the T-13 follow-up. Revisit sooner if the execution role ever gains a
permission beyond logs and traces.
