<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0012: Attribute Memory telemetry and cost by actor id

- Status: Accepted
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The standard asks each shared component to answer "which tenant?" from its
own telemetry and to meter its cost drivers per tenant (§4.4). This sample
has no vendor code on the request path: Gateway, Policy, and Memory are
managed. Gateway and Policy metrics have no tenant dimension; Gateway
application logs can carry request and response bodies
([gateway observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-gateway-metrics.html),
[policy observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-policy-metrics.html)).
Memory's application logs carry `actor_id` and `namespace` for extraction
and consolidation, and its spans carry `actor.id` and `namespace`
([memory observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-memory-metrics.html)).
Under ADR-0009 both are the tenant id.

## Options considered

### Option 1: A metering interceptor on the Gateway

Pros: per-request counts by tenant. Cons: vendor code on the request path,
interceptor support for the Memory connector unverified.

### Option 2: Gateway application logs

Pros: managed. Cons: they can hold request and response bodies, which the
standard keeps out of logs.

### Option 3: Memory application logs and spans, keyed by actor id

Pros: managed, already keyed by the tenant id, no content fields. Cons:
logs cover the asynchronous extraction and consolidation work, not each
request; per-request counts need spans, which need account-level
Transaction Search.

## Decision

Option 3. The construct delivers Memory application logs to a retained log
group and adds two Contributor Insights rules: top tenants by extraction
(`actor_id`) and by consolidation (`namespace`). The Gateway's native rate
limit is keyed on the tenant claim for fairness. Per-request counts by
tenant come from Memory spans when the vendor turns on Transaction Search;
architecture.md names that gap and the join key.

## Consequences

Extraction, the main long-term Memory cost driver, is attributable to a
tenant without vendor code. Gateway and Policy invocations are apportioned
by each tenant's share of Memory operations. Revisit if Gateway metrics or
Policy spans gain a principal or claim dimension.
