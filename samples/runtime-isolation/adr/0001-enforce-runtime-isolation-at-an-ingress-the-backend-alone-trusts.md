<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0001: Enforce runtime isolation at an ingress the backend alone trusts

- Status: Proposed
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Isolating compute services (AgentCore Runtime per `runtimeSessionId`, Lambda per function instance) give each unit its own microVM but do not bind a unit to a caller. With a JWT authoriser on the service, any valid token may name any unit; the vendor must check the mapping itself. That check is the tenant boundary for everything that runs in the unit. AgentCore Runtime is the first backend, so the options below are written against it.

## Options considered
### Option 1: JWT on the Runtime, agent checks the session prefix
Pros: no extra hop, no extra cost. Cons: filtered isolation; the check runs inside the session it guards; one agent bug or dependency compromise and the boundary is gone. A leaked JWT reaches the Runtime from anywhere.
### Option 2: JWT on the Runtime with `allowedWorkloadConfiguration` limited to an AgentCore Gateway
Pros: the Runtime refuses tokens that did not pass the Gateway. Cons: only the Gateway ingress can use it; API Gateway cannot be an allowed workload.
### Option 3: IAM (SigV4) on the Runtime, resource policy allows only the ingress principal
Pros: enforced; IAM, not code in the session, decides who may invoke; the same mechanism serves both ingresses; CloudTrail records every invocation by role. Cons: the ingress is a component the vendor runs and must keep correct.

## Decision
Option 3. It is the only option that makes a forged or leaked JWT useless against the backend on both ingresses, and it moves the mapping check out of the unit it guards (P-1). Every later backend must offer the same: SigV4 inbound auth and a resource policy that can name one principal (ADR-0011). For AgentCore Runtime the policy also denies `InvokeAgentRuntimeForUser`, the WebSocket variants, and `InvokeAgentRuntimeCommand*`, which this sample does not use.

## Consequences
Easier: one auditable gate per ingress, the same for every backend and every optional module (session mapping, scopes, delegation, TVM). Harder: the ingress Lambda (or interceptor) is now security-critical code with unit tests for every refusal. Spike V-1 must show a second role in the same account is denied. Revisit if a backend adds native unit-to-principal binding.
