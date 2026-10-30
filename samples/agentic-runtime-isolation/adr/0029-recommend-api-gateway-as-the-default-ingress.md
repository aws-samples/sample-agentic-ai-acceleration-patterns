<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0029: Recommend API Gateway as the default ingress

- Status: Accepted
- Date: 2026-10-30
- Amends: ADR-0009
- Deciders: Dave Roberts (PSA)

## Context
ADR-0009 chose to pick the recommended ingress by measurement once both meet
P-1 to P-6, and left the recommendation to a follow-up record. Security
parity is reached: both ingresses run the same shared verifier on every
request (ADR-0015), the same TVM, tenant limit and metering, and pass the
same e2e suite.

Measured 2026-10-27 in `eu-central-1` (README, Scale and limits > Latency;
20 `report` calls, no model, warm; one run from one client):

| Ingress | TTFB p50 | TTFB p95 | `stream 10` TTFB | `stream 10` total |
|---|---|---|---|---|
| `api-gateway` | 0.198 s | 0.223 s | 0.168 s | 10.16 s |
| `agentcore-gateway` | 0.274 s | 0.340 s | 0.217 s | 10.20 s |

Both ingresses delivered the first `stream 10` event after about 0.2 s and
the last after about 10 s; spike V-4 (spec §7.1, 2026-10-26) streamed a 36 s
response through the Gateway's REQUEST interceptor, TTFB 0.33 s. The
microVM start belongs to the Runtime and is the same behind either ingress.
Per-request cost was not measured, so ADR-0009's cost comparison and the
spec's per-request cost promise (P-7, §6.3) have no figures behind them.

## Options considered
### Option 1: Recommend `api-gateway`
Pros: lower TTFB at p50 and p95; AWS WAF, usage plans and a stage throttle at
the edge (ADR-0009, ADR-0020); response streaming up to 15 minutes. Cons:
the integration Lambda runs for the whole stream.

### Option 2: Recommend `agentcore-gateway`
Pros: a managed `CUSTOM_JWT` inbound authoriser; MCP-native targets; Cedar
policy and guardrails; the interceptor Lambda runs only before the call.
Cons: slower TTFB at p50 and p95 in the measurement; no stage throttle in
the sample; interceptors are documented as buffered for Runtime targets.

### Option 3: Make no recommendation
Pros: no claim that one run cannot fully support. Cons: ADR-0009 promised one;
a reader choosing a default gets no guidance.

## Decision
Option 1: the sample recommends `api-gateway` as the default ingress, because
with security at parity it was faster to first byte at p50 and p95 and adds
edge controls the sample already uses, and `agentcore-gateway` stays the
deploy-time alternative (ADR-0003); the per-request cost comparison is
withdrawn rather than estimated, by a dated amendment to the spec's P-7 and
§6.3.

## Consequences
Easier: the README names one default and why. Harder: the recommendation
rests on one run from one client in one Region, and on latency alone after
security, not on cost. Revisit if AgentCore Gateway documents pass-through
streaming for Runtime targets with interceptors, if a repeat of
`scripts/perf.sh` changes the order, or if per-request cost is measured.
