<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0001: Enforce session mapping at an ingress the Runtime alone trusts

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
AgentCore Runtime gives each `runtimeSessionId` a dedicated microVM but does not bind a session to a caller. With a JWT authoriser on the Runtime, any valid token may name any session id; the vendor must check the mapping itself. The check is the tenant boundary for live conversation state.

## Options considered
### Option 1: JWT on the Runtime, agent checks the session prefix
Pros: no extra hop, no extra cost. Cons: filtered isolation; the check runs inside the session it guards; one agent bug or dependency compromise and the boundary is gone. A leaked JWT reaches the Runtime from anywhere.
### Option 2: JWT on the Runtime with `allowedWorkloadConfiguration` limited to an AgentCore Gateway
Pros: the Runtime refuses tokens that did not pass the Gateway. Cons: only the Gateway ingress can use it; API Gateway cannot be an allowed workload.
### Option 3: IAM (SigV4) on the Runtime, resource policy allows only the ingress principal
Pros: enforced; IAM, not code in the session, decides who may invoke; the same mechanism serves both ingresses; CloudTrail records every invocation by role. Cons: the ingress is a component the vendor runs and must keep correct.

## Decision
Option 3. It is the only option that makes a forged or leaked JWT useless against the Runtime on both ingresses, and it moves the mapping check out of the microVM (P-1). The resource policy also denies `InvokeAgentRuntimeForUser`, the WebSocket variants, and `InvokeAgentRuntimeCommand*`, which this sample does not use.

## Consequences
Easier: one auditable gate per ingress. Harder: the ingress Lambda (or interceptor) is now security-critical code with unit tests for every refusal. Spike V-1 must show a second role in the same account is denied. Revisit if Runtime adds native session-to-principal binding.
