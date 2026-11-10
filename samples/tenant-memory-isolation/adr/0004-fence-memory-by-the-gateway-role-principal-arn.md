<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0004: Fence Memory data access by the Gateway role's principal ARN

- Status: Accepted
- Date: 2026-10-26
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

Cedar only protects requests that pass through Gateway. Any principal in the
vendor's account with an identity Allow could call Memory directly, so the
Memory resource needs its own boundary: a resource policy that denies data
access to everything except the Gateway's path.

## Options considered

### Option 1: Condition on the Gateway as the source (`aws:SourceArn`)

Names the Gateway itself. In the live run on 2026-10-26 the native connector's
calls did not carry `aws:SourceArn`, so this Deny matched the Gateway's own
requests and denied them.

### Option 2: Condition on the execution role (`aws:PrincipalArn`)

Names the one role the connector signs with. Anyone who can assume the role
is inside the fence, so the role's trust policy becomes part of the
boundary.

## Decision

Option 2. The resource policy denies every Memory data operation (ADR-0007)
unless `aws:PrincipalArn` is the Gateway execution role. The role trusts only
`bedrock-agentcore.amazonaws.com`, pinned to the vendor's account and to the
Gateway and Policy engine ARNs. The live harness checks both documents
together (`assert_fence`, `assert_execution_role`).

## Consequences

The fence and the role trust are one boundary and are reviewed together; a
broader trust policy would let a caller obtain the role and step inside the
fence. Changing the outbound identity (for example to caller credentials)
means rewriting the fence.

The current connector guide recommends `aws:PrincipalArn` on the execution
role for `GATEWAY_IAM_ROLE`, as decided here, and also states that the
Gateway stamps `aws:SourceArn` with its ARN in both outbound modes
([connector guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-connector.html#memory-gateway-connector-credential-modes),
[restrict direct access](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-restrict-access.html)).
That differs from the 2026-10-26 observation, so the next live run re-tests
it. If `aws:SourceArn` is present, the fence adds it as a second condition;
the Deny form stays, because an Allow-only resource policy does not stop a
principal in the same account whose identity policy already allows the call.
