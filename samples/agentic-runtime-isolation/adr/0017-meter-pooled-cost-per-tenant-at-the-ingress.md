<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0017: Meter pooled cost per tenant at the ingress, with the agent reporting usage

- Status: Accepted
- Date: 2026-10-26
- Amended by: ADR-0018, ADR-0021
- Deciders: Dave Roberts (PSA)

## Context
The standard (§4.4) requires per-tenant cost attribution. The backend, model, gateway, and Lambda are pooled, so AWS cost allocation tags cannot split them by tenant. The ingress knows the verified tenant and wraps the whole request; the agent knows the model usage (tokens) but, by P-6, knows the tenant only through what the ingress hands it.

## Options considered
### Option 1: One backend per tenant, tagged `TenantId`
Pros: cost allocation tags do the work. Cons: the silo model, not this pattern; a Runtime per tenant multiplies fixed cost and deploy time.
### Option 2: The agent emits per-tenant cost metrics itself
Cons: the agent must be told the tenant for a purpose other than isolation, widening what the microVM holds; every consumer's agent must reimplement the metering.
### Option 3: The ingress meters what it can observe and the agent returns usage figures in a final `usage` event of the response stream, which the ingress reads and emits as per-tenant metrics
Pros: one metering point that already attributes requests (P-9); the agent reports numbers only; consumers keep the metering when they swap the agent as long as they emit the event. Cons: a contract between agent and ingress; usage not reported means tokens are unattributed, which the metric then shows as a gap.

## Decision
Option 3. The ingress emits, per request, with `TenantId` and `Ingress` dimensions: `Requests`, `IngressDurationMs`, `BackendInvokeSeconds`, `ModelInputTokens`, `ModelOutputTokens`, `StreamedBytes` (plus the P-9 errors and TTFB). The agent's last SSE event is `event: usage` with `{inputTokens, outputTokens, modelId}`; the ingress strips nothing and forwards the stream unchanged, so the client sees it too. The demo adds Contributor Insights rules for top tenants by `BackendInvokeSeconds` and `ModelOutputTokens`, and the README states the formula: cost per tenant = sum over metrics of (metric x unit price) plus an equal share of the unattributable remainder.

## Consequences
Easier: a tenant's cost is one CloudWatch query; tiers and fair-use limits can key on the same metrics. Harder: the usage event is a contract the README must document for consumers' own agents; CloudWatch custom metrics cost money per metric-dimension pair, so the construct keeps the set small and the README says so. Revisit if AgentCore Runtime exposes per-invocation CPU and memory seconds, which would replace wall time.

Amended by ADR-0018: model token cost is read from CUR 2.0 by IAM principal (`iamPrincipal/TenantId`) rather than from the usage event; the usage event and the `ModelInputTokens`/`ModelOutputTokens` metrics stay as a near-real-time cross-check, not the billing source.

Amended by ADR-0021: the per-tenant metrics are opt-in (`perTenantMetrics`, off by default) because their cost grows with tenants; the ingress log line carries the same figures, and the demo Contributor Insights rules read the log line instead of the metrics.
