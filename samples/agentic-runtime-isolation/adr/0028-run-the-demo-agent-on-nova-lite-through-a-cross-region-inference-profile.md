<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0028: Run the demo agent on Nova Lite through a cross-Region inference profile

- Status: Accepted
- Date: 2026-10-30
- Deciders: Dave Roberts (PSA)

## Context
The demo agent calls one model, Amazon Nova Lite (`DEFAULT_MODEL_ID =
'amazon.nova-lite-v1:0'` in `src/demo.cdk.ts`), and the tenant role allows
that one model only (P-6, ADR-0018). In most Regions, `eu-central-1`
included, Nova Lite is served on demand only through a cross-Region inference
profile: an on-demand call with the base id `amazon.nova-lite-v1:0` there is a
`ValidationException`. This was found on the first integration run,
2026-10-27, which runs in `eu-central-1`.

An inference profile call is authorised twice: on the profile ARN, which is
account-scoped in the calling Region, and on the foundation-model ARN in each
Region the profile routes to. A grant on the base model in this Region alone,
which is what a plain id needs, refuses the profile call.

## Options considered
### Option 1: Keep the base id and require deployers to pick a Region where it is served on demand
Pros: the tenant role names one ARN with no wildcard. Cons: the demo fails
out of the box in the Region the sample is tested in; the error names no
remedy.

### Option 2: Make `modelId` a required context value with no default
Pros: no assumption about the deployer's Region. Cons: one more required input
for a demo whose point is runtime isolation, not model choice; each deployer
has to learn the profile rule anyway.

### Option 3: Default to the geography's profile, derived from the Region
`defaultModelId(region)` maps the Region's first segment
(`region.split('-')[0]`) `eu`, `us`, `ap` to the prefix `eu.`, `us.`, `apac.`;
any other or unresolved Region gets the base id. `--context modelId=...`
overrides it. Pros: works without configuration in the tested Regions; a
deployer elsewhere still gets a valid id to override. Cons: the mapping is a
small table the sample keeps; the tenant role's model grant gets a Region
wildcard.

## Decision
Option 3. The demo defaults to the geography's Nova Lite inference profile
(`src/demo.cdk.ts`, `defaultModelId`; the integration test uses the same
function in `test/integ.runtime.ts` unless `INTEG_MODEL_ID` is set), and the
construct accepts either form: `modelResourceArns` in
`src/backend/agentcore-runtime.cdk.ts` grants a plain id on the
foundation-model ARN in this Region only, and a profile id (prefix `us.`,
`eu.`, `apac.`, `global.`, `us-gov.`, `jp.`, `au.` or `ca.`) on the exact
profile ARN plus the foundation-model ARN of the same base model in any
Region.

## Consequences
Easier: the demo and the integration test run in `eu-central-1`, `us-*` and
`ap-*` Regions with no model setting; the agent receives the profile id as
given (`MODEL_ID`). Harder: the tenant role's `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream` statement names
`arn:<partition>:bedrock:*::foundation-model/amazon.nova-lite-v1:0`, a Region
wildcard on one named model, which raises cdk-nag `AwsSolutions-IAM5`; it is
acknowledged where the statement is added (`addModelStatement` in
`src/shared-ingress.cdk.ts`), and the model itself is never wildcarded.
`test/demo.cdk.test.ts` pins the mapping (`eu-central-1`, `us-east-1`,
`ap-southeast-2`, and the base id for `ca-central-1` and an unresolved
Region); `test/runtime-isolation.cdk.test.ts` pins both grant forms and that
cdk-nag passes with the acknowledgment. Revisit if Nova Lite becomes
available on demand by base id in the tested Regions, or if the deployer
needs the grant limited to the profile's own Regions.
