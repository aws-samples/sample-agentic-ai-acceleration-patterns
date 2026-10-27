<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0011: Model the compute service as a backend, with AgentCore Runtime first

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Runtime isolation does not depend on AgentCore. It needs two things from the compute service: it runs work in isolated units (a session, a function instance, a container), and it can be locked to one calling IAM principal (P-1, P-2). AgentCore Runtime offers both today. AWS Lambda's microVMs are a candidate for a later backend. Naming the sample and construct after AgentCore would make a second backend a rename.

## Options considered
### Option 1: An AgentCore-only sample (`runtime-isolation-agentcore`)
Pros: no abstraction. Cons: a second backend needs a second sample or a rename; the principles read as AgentCore features rather than the pattern.
### Option 2: A pluggable backend interface now, with two backends
Cons: the second backend's isolation is unproven; building it now is speculative.
### Option 3: A `backend` prop with one value, `'agentcore-runtime'`; principles written against the backend
Pros: the pattern, name, and contract stay stable when a backend is added; no speculative code. Cons: a prop with one value until a second backend exists.

## Decision
Option 3. The sample is `runtime-isolation`; `IsolatedRuntime` takes `backend` (default `'agentcore-runtime'`). The ingress, claim validation, unit selection (random or session-derived), and the TVM's credential vending are backend-neutral. A backend owns five things: what its isolation unit is, its invoke call, its resource policy (P-1), how the unit id is carried to it, and how vended credentials and the forwarded user token are carried to it (ADR-0012). For `agentcore-runtime` these are one `runtimeSessionId` per microVM, `InvokeAgentRuntime`, the runtime resource policy, `runtimeSessionId`, and allowlisted `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` headers. `agentcore-gateway` ingress is valid only with the AgentCore backend.

## Consequences
Easier: adding a backend is a new prop value plus those five things, run through the same e2e suite. Harder: keep AgentCore-specific details (headers, `InvokeAgentRuntime`) out of the shared ingress code; the backend interface is where they live. Revisit when a second backend is designed: it is accepted only once it passes P-1 and P-2 in the integration test.
