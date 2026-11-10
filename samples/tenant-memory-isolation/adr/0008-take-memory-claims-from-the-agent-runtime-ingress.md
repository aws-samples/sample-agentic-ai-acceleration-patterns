<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->
# ADR-0008: Take memory claims from the agent runtime ingress

- Status: Proposed
- Date: 2026-11-10
- Deciders: Daniel Wirjo (Solutions Architect)

## Context

The sample should compose with `agentic-runtime-isolation`, whose ingress
mints a 5-minute transaction token from a `tenant-identity` identity token.
The token carries `iss`, `sub` (`<tenant_id>#<user>`), `user`, `tenant_id`,
`agent`, `scope`, `aud` (`agent:<name>` and `tools-gateway:<name>`), `act`,
`txn`, and `exp`; it has no `client_id`, `token_use`, session, or namespace
claim. Three constraints shape the composition:

- The Memory connector is an HTTP target, and HTTP targets need a Gateway
  without an MCP protocol type (ADR-0006). The ingress's tools gateway is an
  MCP Gateway whose REQUEST interceptor admits only MCP JSON-RPC, so Memory
  cannot be one of its targets.
- Cedar cannot concatenate strings, so a policy cannot turn `tenant_id` into
  `/tenants/<tenant_id>/shared/`; the namespace must arrive as a claim
  ([policy examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-gateway-fgac-policy-examples.html)).
- Namespaces need a leading and trailing slash to avoid prefix collisions
  ([memory organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html)),
  so a namespace cannot equal a bare tenant id.

## Options considered

### Option 1: A Memory tool behind the tools gateway

A Lambda `ToolTarget` calls Memory with tenant credentials from the tool
library. Cons: replaces the native connector and per-field Cedar with vendor
code and a star permit, and reaches Memory through credential vending, which
ADR-0001 rules out.

### Option 2: This sample's Memory Gateway trusts the ingress issuer

The construct's Gateway keeps the native connector and per-field Cedar, with
`CUSTOM_JWT` on the ingress's published `issuer` discovery URL and
`allowedAudience` set to the `agent:<name>` audiences of agents that may use
memory. Mapping: `actorId == tenant_id`; `sessionId == agent`, one memory
session per tenant and agent; `namespacePath ==` a namespace claim the
ingress mints from the same tenant id. Cons: needs one additive producer
change (the namespace claim, with an ADR in `agentic-runtime-isolation`) and,
for the integration test, an agent backend that calls the Memory Gateway,
because the published interface offers no other way to obtain a transaction
token.

### Option 3: A producer-agnostic construct with a bundled demo issuer

The same construct, with its demo and integration test supplying a synthetic
Cognito issuer that mints the three memory claims from one tenant id. Cons:
shows the claim contract rather than the platform composition.

## Decision

Proposed: build the construct producer-agnostic (issuer discovery URL,
allowed audiences or clients, and the claim names for tenant, session, and
namespace as props), so options 2 and 3 differ only in the demo and the
integration test. Option 2 waits on the producer change; option 3 ships
first.

## Consequences

Option 2 ties actor and namespace in the producer, which mints both from one
verified tenant id (T-1). Its 5-minute token shortens the expiry probe. The
`token_use` and `client_id` checks become `aud` checks at the Gateway.
