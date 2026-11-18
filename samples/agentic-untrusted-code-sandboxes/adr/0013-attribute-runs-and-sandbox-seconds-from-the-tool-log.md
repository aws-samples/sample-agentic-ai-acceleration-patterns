<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0013: Attribute runs and sandbox seconds from the tool log

- Status: Proposed
- Date: 2026-11-18
- Deciders: Dave Roberts (Partner Solutions Architect)

## Context

R-7 and standard §4.4 ask that every run and its cost be attributable to a
tenant. The sandbox itself is not a reliable witness: MicroVMs log nothing,
and code can write into the runner's stream. The tool and the stopping
functions know the verified tenant. Per-tenant CloudWatch metrics grow with
the tenant count (agentic-runtime-isolation ADR-0021).

## Options considered

### Option 1: One structured tool line per call and one per stopped sandbox; EMF metrics opt-in
Pros: top-level `tenantId` fields for Logs Insights and Contributor
Insights at no per-tenant cost; `sandboxSeconds` per stop drives the cost
split on every backend. Cons: dashboards per tenant need the opt-in.

### Option 2: Always-on per-tenant metrics
Pros: ready dashboards. Cons: cost grows with tenants.

### Option 3: Rely on resource tags only
Pros: Cost Explorer native. Cons: AgentCore sessions are pooled and
MicroVM tagging is unconfirmed (S-3).

## Decision

Option 1 (spec §3.8), with `perTenantMetrics` off by default. The tool
line carries the sandbox `handle`, so other usage sources join to the
tenant: `nitro` tags tasks with `TenantId` for ECS split cost allocation
data, `microvm` tags MicroVMs if S-3 allows, and `agentcore` cost comes
from AgentCore's session-level usage logs keyed by `runtimeSessionId`
(consumption billing, no configured baseline). On `microvm` the stop line
splits running and suspended seconds from a per-row suspended counter;
the API reports no per-state times, so the split is marked estimated.

## Consequences

The README Costs section gives the formula per backend and names what stays
unattributed (idle capacity, NAT, endpoints, image builds) and how to
apportion it. The integration test checks the tool line's fields.
