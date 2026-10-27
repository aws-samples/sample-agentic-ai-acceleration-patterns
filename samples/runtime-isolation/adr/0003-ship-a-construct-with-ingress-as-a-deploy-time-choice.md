<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0003: Ship one construct with the ingress as a deploy-time choice

- Status: Accepted
- Date: 2026-10-26
- Deciders: Dave Roberts (PSA)

## Context
Readers want to compare API Gateway and AgentCore Gateway in front of a Runtime, and the standard (§4.5) requires the pattern as a construct.

## Options considered
### Option 1: Two samples, one per ingress
Cons: duplicated Runtime, policy, and tests; the comparison is spread across two READMEs.
### Option 2: One construct, `ingress: 'api-gateway' | 'agentcore-gateway'`
Pros: identical Runtime and policy, one e2e suite run twice, a direct latency and cost table. Cons: the construct carries two ingress implementations.
### Option 3: Both ingresses at once on one Runtime
Cons: the Runtime would trust two principals, which weakens P-1 for the demo's sake.

## Decision
Option 2. `IsolatedRuntime` creates the backend and exactly one ingress; its resource policy names only that ingress's principal.

## Consequences
Easier: like-for-like measurement. Harder: two code paths to keep equivalent; the shared session module and one e2e suite are the guard.
