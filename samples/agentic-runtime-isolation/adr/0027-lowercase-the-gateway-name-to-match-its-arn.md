<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0027: Lowercase the Gateway name to match its ARN

- Status: Accepted
- Date: 2026-10-30
- Deciders: Dave Roberts (PSA)

## Context
On `agentcore-gateway` the Gateway assumes its own role to call the REQUEST
interceptor and the Runtime targets. The role's trust policy names the
service principal `bedrock-agentcore.amazonaws.com` with two conditions:
`StringEquals aws:SourceAccount` on the stack's account, and `ArnLike
aws:SourceArn` on `arn:<partition>:bedrock-agentcore:<region>:<account>:gateway/<name>-*`
(`src/shared-ingress.cdk.ts`, `agentCoreGatewayIngress`). The Gateway name is
derived from the construct path with `Names.uniqueResourceName`, which keeps
the path's mixed case.

AgentCore lowercases the name when it builds the gateway id, and so the
Gateway ARN. `ArnLike` compares case-sensitively, so with a mixed-case name
the request's `aws:SourceArn` never matches the trust condition: the Gateway
cannot assume its role and refuses every request. This was found on the first
integration run, 2026-10-27; unit tests and cdk-nag pass either way.

## Options considered
### Option 1: Lowercase the name at synth and keep the ARN condition
Pros: the trust still names this one Gateway, so no other Gateway in the
account can assume the role (confused deputy); one `.toLowerCase()`, pinned
by a unit test. Cons: the name no longer reads exactly as the construct
path; two paths that differ only in case still get different names, because
the hash `Names.uniqueResourceName` appends is taken over the original path.

### Option 2: Drop the `aws:SourceArn` condition
Pros: no dependency on how the service spells the id. Cons: any AgentCore
Gateway in the account could assume the role, and that role is the one
principal every Runtime behind this ingress trusts (P-1, ADR-0001); a weaker
trust on that role weakens the sample's central boundary.

### Option 3: Keep `aws:SourceAccount` only
Pros: as Option 2, and still limited to this account. Cons: as Option 2;
within the account the trust is no longer bound to this Gateway.

## Decision
Option 1. The name is
`${Names.uniqueResourceName(this, { maxLength: 40, separator: '-' })}-gw`
lowercased, which still matches the service's pattern
`^([0-9a-zA-Z][-]?){1,48}$`, and the role keeps both conditions, so the
principal every Runtime trusts can be assumed only by this Gateway in this
account.

## Consequences
Easier: the Gateway assumes its role on the first deploy; the trust stays as
narrow as before. `test/runtime-isolation.cdk.test.ts` ("the Gateway name is
lowercase and the role trust names it exactly") asserts the name is lower
case and that the `aws:SourceArn` condition contains `:gateway/<name>-*`.
Harder: the fix is invisible in a template review, so the code comment at the
name and this record carry the reason. Revisit if AgentCore documents
case-preserving gateway ids.
