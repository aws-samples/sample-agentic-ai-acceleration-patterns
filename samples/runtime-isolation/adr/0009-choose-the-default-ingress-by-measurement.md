<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0009: Choose the recommended ingress by measurement, after security parity

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
The user's order is security, then performance, then cost. Both ingresses meet P-1 to P-6. Documented differences: API Gateway REST adds WAF, usage plans, and response streaming to 15 minutes, but its integration Lambda runs for the whole stream. AgentCore Gateway adds Cedar policy and guardrails, its interceptor Lambda runs only before the call, but interceptors are documented as buffered only for Runtime targets.

## Options considered
### Option 1: Pick now from documentation
Cons: latency claims would be guesses.
### Option 2: Measure TTFB and total latency (p50, p95) and compute per-request cost in the integ run, then decide
Pros: the README states numbers, date, and Region.

## Decision
Option 2. This ADR stays Proposed until the integ run; a follow-up ADR records the recommendation.

## Consequences
Expected shape, to be confirmed: Gateway cheaper per long streamed answer (interceptor Lambda is short; API Gateway's Lambda bills for the whole stream); API Gateway richer at the edge (WAF, per-tenant throttling).
