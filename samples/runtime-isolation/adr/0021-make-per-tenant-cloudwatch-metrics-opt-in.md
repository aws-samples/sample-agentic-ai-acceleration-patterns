<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0021: Make per-tenant CloudWatch metrics opt-in, off by default

- Status: Proposed. Amends ADR-0017.
- Date: 2026-10-27
- Deciders: Dave Roberts (PSA)

## Context
ADR-0017 emits nine EMF metrics per request with `TenantId` and `Ingress` dimensions. CloudWatch bills each metric-dimension combination as a custom metric. At 10,000 tenants on one ingress that is about 90,000 custom metrics, roughly $11k per month at list price (an unverified estimate; check current CloudWatch pricing). Dashboards built on `SEARCH` stop being readable past a few hundred series. Standard §4.4 asks for per-tenant observability "where practical" and for cost attribution; it does not require a metric per tenant.

## Options considered
### Option 1: Keep per-tenant metrics always on
Pros: no change. Cons: cost grows linearly with tenants and lands on every deployer by default.
### Option 2: Drop per-tenant metrics entirely
Pros: no metric cost. Cons: a small deployment loses near-real-time per-tenant graphs it can afford.
### Option 3: Opt-in metrics; the structured log line carries the same figures
Pros: cost attribution still works at any scale through Logs Insights and Contributor Insights; small deployments can turn the metrics on. Cons: per-tenant graphs need a query or a rule rather than a metric.

## Decision
Option 3. New prop `perTenantMetrics?: boolean`, default `false`. When `true` the construct adds a synth warning with id `runtime-isolation:per-tenant-metrics-cost` that states the metric count per tenant.

With metrics off, the ingress log line still carries `tenantId`, `status`, `ttfbMs`, `streamedBytes`, `backendInvokeSeconds`, `usageInput`, `usageOutput` and `modelId`. The line is `request served` on `api-gateway` and `request admitted` on the interceptor. Cost attribution (standard §4.4) works through Logs Insights and Contributor Insights. Model cost per tenant still comes from CUR 2.0 by `iamPrincipal/TenantId` (ADR-0018).

The logger now writes raw JSON lines to stdout, as EMF does, instead of calling `console.log`. Under the Lambda JSON log format a `console.log` string lands as `{"message":"<string>"}`, so the fields would not be top level and Contributor Insights could not key on them.

The demo's Contributor Insights rules (top tenants by backend seconds and by output tokens) now read the log line: `$.tenantId`, `$.backendInvokeSeconds`, `$.usageOutput`, filtered on `$.message In ['request served']`. They work with metrics off. Contributor Insights bills per rule and per matched log event, not per tenant. The demo dashboard is added only with `--context perTenantMetrics=true`.

## Consequences
Easier: the default deployment's metric cost no longer grows with tenants; cost attribution keeps working from the log.

Harder: per-tenant graphs need a Logs Insights query or a Contributor Insights rule; Contributor Insights reports the top 500 contributors per rule, so a long tail is visible only through Logs Insights. Deployers who relied on the ADR-0017 metrics must set `perTenantMetrics: true`.

Revisit if CloudWatch prices high-cardinality dimensions differently.
